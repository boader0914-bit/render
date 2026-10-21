"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { findExistingObservationIds } = require("./lib/history_observation_append.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t, content = "", options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-observation-index-"));
  const file = path.join(directory, "observations.jsonl"), indexFile = path.join(directory, "derived", "index.sqlite");
  if (content !== null) await fs.writeFile(file, content);
  const stores = [], create = overrides => { const store = createHistoryObservationIndex({ file, indexFile, ...options, ...overrides }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close().catch(() => {}); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, file, indexFile, create, store: create() };
}
const line = value => JSON.stringify(value);
async function rows(store, query = {}) { const result = []; await store.readRows(query, (row, ordinal) => result.push({ row, ordinal })); return result; }

test("raw physical rows, BOM modes, malformed diagnostics, typed IDs and original byte preservation", async t => {
  const values = ["\uFEFF" + line({ observationId: "7", companyKey: " A ", stayDate: "2026-09-99", sold: 0 }), "", " ", "{partial", "null", "[]", "7",
    "\uFEFF" + line({ observationId: "second-bom", companyId: "B", date: "2026-10-weird" }),
    line({ observationId: 7, companyKey: "B", stayDate: "2026-09-01" }), line({ observationId: true }), line({ observationId: 0 }), line({ observationId: { id: "7" } })];
  const f = await fixture(t, values.join("\r\n")), before = await fs.readFile(f.file), descriptor = await f.store.ensure();
  assert.equal(descriptor.rows, values.length); assert.equal(descriptor.blankLines, 2); assert.equal(descriptor.malformedLines, 4);
  assert.equal(descriptor.malformedHistoryLines, 4); assert.equal(descriptor.needsSeparator, true);
  const read = []; await f.store.readLines({}, (raw, row, ordinal) => read.push({ raw, row, ordinal }));
  assert.equal(read[0].raw, values[0]); assert.equal(read[0].row.sold, 0); assert.equal(read[1].ordinal, 8);
  assert.deepEqual(await f.store.listMonths(), ["2026-10", "2026-09"]);
  assert.equal((await rows(f.store, { month: "2026-09", refs: ["a"] })).length, 1);
  assert.equal((await rows(f.store, { month: "2026-10" })).length, 1, "monthly accepts a month prefix without requiring valid days");
  assert.equal((await rows(f.store, { parseMode: "detail" })).some(value => value.ordinal === 1 || value.ordinal === 8), false);
  const ids = ["7", 7, "second-bom", true, 0, { id: "7" }, "missing"];
  const indexed = await f.store.findObservationIds({ observationIds: ids }), baseline = await findExistingObservationIds({ file: f.file, observationIds: ids });
  assert.deepEqual([...indexed.existingIds], [...baseline.existingIds]); assert.equal(indexed.needsSeparator, baseline.needsSeparator);
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("monthly retains duplicate physical rows and raw-ID references include merged and inferred place forms", async t => {
  const source = [{ observationId: "same", companyKey: "cmp_place_123", stayDate: "2026-09-01", runId: "one", sold: 1 },
    { observationId: "same", companyKey: " B ", stayDate: "2026-09-01", runId: "one", sold: 8 },
    { observationId: "same", companyId: "legacy-A", place_id: 123, stayDate: "2026-09-01", runId: "two", sold: null, missing: true },
    { observationId: "new", companyKey: "123", stayDate: "2026-09-02", runId: "two", sold: 0 }];
  const f = await fixture(t, source.map(line).join("\n") + "\n");
  assert.equal((await rows(f.store)).length, 4, "observation ID winner must not discard a monthly input");
  assert.deepEqual((await rows(f.store, { refs: ["123"] })).map(value => value.ordinal), [1, 3, 4]);
  assert.deepEqual((await rows(f.store, { refs: { companyIds: [" LEGACY-a "] }, runId: "two" })).map(value => value.ordinal), [3]);
  const headers = []; await f.store.readHeaders({ month: "2026-09" }, (header, ordinal) => headers.push({ header, ordinal }));
  assert.equal(headers[0].header.sold, undefined); assert.equal(headers[2].header.place_id, 123); assert.equal(f.store.stats().headersRead, 4);
  const partitions = await f.store.revisionPartitions();
  assert.equal(partitions.partitions.length, 4); assert.deepEqual(partitions.partitions.flatMap(partition => partition.runIds).sort(), ["one", "one", "two", "two"]);
});

test("invalid days remain month dependencies so discarded/partial evidence can invalidate that month", async t => {
  const f = await fixture(t, line({ observationId: "a", companyKey: "one", stayDate: "2026-09-xx", missing: true }) + "\n"
    + line({ observationId: "b", companyKey: "one", stayDate: "2026-10", missing: true }) + "\n");
  const before = await f.store.revisionPartitions();
  assert.equal(before.partitions.length, 2); const september = before.partitions.find(value => value.month === "2026-09"); assert.ok(september);
  assert.deepEqual(await f.store.listMonths(), ["2026-10", "2026-09"], "selector month slicing remains a separate contract");
  await f.store.append(line({ observationId: "c", companyKey: "one", stayDate: "2026-09-??", partial: true }) + "\n");
  const after = await f.store.revisionPartitions(), updated = after.partitions.find(value => value.month === "2026-09");
  assert.notEqual(updated.digest, september.digest); assert.equal(updated.count, 2);
  assert.deepEqual(after.partitions.find(value => !value.month), before.partitions.find(value => !value.month));
});

test("empty-month partitions retain all object capacity evidence and allow a narrow partition read", async t => {
  const source = [
    { observationId: "no-date", companyId: "exact-ID", companyKey: "other-ID", productType: "lodging", rawTotal: 16, inventoryEvidenceVersion: 4 },
    { observationId: "partial", companyId: "exact-ID", companyKey: "other-ID", productType: "lodging", rawTotal: 99, inventoryEvidenceVersion: 4, partial: true },
    { observationId: "bad-date", companyId: "exact-ID", companyKey: "other-ID", stayDate: "not-a-date", productType: "lodging", rawTotal: 18 },
    { observationId: "dated", companyId: "exact-ID", stayDate: "2026-09-01", productType: "lodging", rawTotal: 20 },
    {}
  ];
  const f = await fixture(t, source.map(line).join("\n") + "\n"), before = await f.store.revisionPartitions();
  const selected = before.partitions.find(value => value.month === "" && value.companyId === "exact-ID");
  assert.equal(selected.companyKey, "other-ID"); assert.equal(selected.count, 3);
  assert.deepEqual((await rows(f.store, { partitionKey: selected.key })).map(value => value.row), source.slice(0, 3));
  assert.equal(f.store.stats().rowsRead, 3, "unrelated and dated payloads are not reconstructed for this partition");
  await f.store.append(line({ observationId: "new", companyId: "new-company", productType: "lodging", rawTotal: 12 }) + "\n");
  const after = await f.store.revisionPartitions(); assert.deepEqual(after.partitions.find(value => value.key === selected.key), selected);
  await assert.rejects(f.store.readRows({ partitionKey: "invalid" }, () => {}), TypeError);
});

test("unchanged restarts reuse the saved index without reading source bodies", async t => {
  const f = await fixture(t, line({ observationId: "x", companyKey: "a", stayDate: "2026-09-01" }) + "\n");
  const first = await f.store.ensure(), original = await fs.readFile(f.file);
  await f.store.close();
  const fileSystem = Object.create(fs); fileSystem.open = async () => { throw new Error("Raw source must not open on index reuse"); };
  const next = f.create({ fileSystem }), saved = await next.ensure();
  assert.equal(saved.mode, "unchanged"); assert.equal(saved.contentDigest, first.contentDigest); assert.equal(saved.generation, first.generation);
  assert.equal((await rows(next)).length, 1); assert.equal(next.stats().bytesReadOriginal, 0); assert.deepEqual(await fs.readFile(f.file), original);
});

test("trusted append reads appended bytes only and rehashes touched partitions while preserving others", async t => {
  const source = [{ observationId: "a", companyKey: "a", stayDate: "2026-09-01", runId: "first" }, { observationId: "b", companyKey: "b", stayDate: "2026-08-01", runId: "older" }];
  const f = await fixture(t, source.map(line).join("\n") + "\n");
  await f.store.ensure(); const before = await f.store.revisionPartitions(), bytesBefore = f.store.stats().bytesReadOriginal;
  const payload = line({ observationId: "c", companyKey: "a", stayDate: "2026-09-02", runId: "second" }) + "\n";
  const appended = await f.store.append(payload), after = await f.store.revisionPartitions();
  assert.equal(appended.indexed, true); assert.equal(appended.descriptor.mode, "incremental");
  assert.equal(f.store.stats().bytesReadOriginal - bytesBefore, Buffer.byteLength(payload));
  const oldA = before.partitions.find(part => part.companyKey === "a"), newA = after.partitions.find(part => part.companyKey === "a");
  assert.notEqual(newA.digest, oldA.digest); assert.equal(newA.count, 2); assert.deepEqual(newA.runIds, ["first", "second"]);
  assert.deepEqual(after.partitions.find(part => part.companyKey === "b"), before.partitions.find(part => part.companyKey === "b"));
  assert.deepEqual(await fs.readFile(f.file, "utf8"), source.map(line).join("\n") + "\n" + payload);
  assert.equal((await f.store.ensure()).mode, "unchanged");
});

test("unterminated complete, partial, CR and multibyte tails retain exact readline semantics", async t => {
  for (const ending of [line({ observationId: "a", companyKey: "가", stayDate: "2026-09-01" }), '{"observationId":"a"', "\r", "\r\n"]) {
    const f = await fixture(t, ending), descriptor = await f.store.ensure();
    const payload = (descriptor.needsSeparator ? "\n" : "") + line({ observationId: "b", companyKey: "나", stayDate: "2026-10-01" }) + "\r\n";
    assert.equal((await f.store.append(payload)).indexed, true);
    const first = await f.store.ensure(), rebuilt = f.create();
    const result = await rows(rebuilt);
    assert.equal(result.at(-1).row.companyKey, "나"); assert.equal(first.contentDigest, (await rebuilt.ensure()).contentDigest);
    const ids = await f.store.findObservationIds({ observationIds: ["a", "b"] }), baseline = await findExistingObservationIds({ file: f.file, observationIds: ["a", "b"] });
    assert.deepEqual([...ids.existingIds], [...baseline.existingIds]); assert.equal(ids.needsSeparator, false);
  }
});

test("a partial tail completed by append is reclassified and removed from malformed diagnostics", async t => {
  const f = await fixture(t, '{"observationId":"a","companyKey":"one","stayDate":"2026-09-01"');
  assert.equal((await f.store.ensure()).malformedLines, 1);
  assert.equal((await f.store.append('}\n')).indexed, true);
  assert.equal((await f.store.ensure()).malformedLines, 0); assert.equal((await rows(f.store))[0].row.observationId, "a");
});

test("a CR at the old EOF and a newly appended LF stay one delimiter rather than adding a blank row", async t => {
  const original = line({ observationId: "a", companyKey: "one", stayDate: "2026-09-01" });
  for (const payload of ["\n", "\n" + line({ observationId: "b", companyKey: "one", stayDate: "2026-10-01" }) + "\n"]) {
    const f = await fixture(t, original + "\r"), before = await f.store.ensure();
    assert.equal(before.endsWithCR, true); assert.equal((await f.store.append(payload)).indexed, true);
    const incremental = await f.store.ensure(), normalRows = await rows(f.store);
    assert.equal(incremental.blankLines, 0); assert.equal(incremental.rows, payload === "\n" ? 1 : 2);
    if (payload === "\n") assert.equal(incremental.contentDigest, before.contentDigest);
    const replacement = await fs.readFile(f.file); await fs.writeFile(f.file, replacement);
    const rebuilt = await f.store.ensure(); assert.equal(rebuilt.mode, "rebuilt");
    assert.equal(rebuilt.contentDigest, incremental.contentDigest); assert.deepEqual(await rows(f.store), normalRows);
  }
});

test("external append, prefix edit plus append, truncate and atomic replacement all rebuild", async t => {
  const f = await fixture(t, line({ observationId: "a", companyKey: "one", sold: 0 }) + "\n");
  const initial = await f.store.ensure();
  await fs.appendFile(f.file, line({ observationId: "b", companyKey: "two" }) + "\n");
  assert.equal((await f.store.ensure()).mode, "rebuilt");
  await fs.writeFile(f.file, line({ observationId: "a", companyKey: "one", sold: 9 }) + "\n" + line({ observationId: "c", companyKey: "three" }) + "\n");
  assert.equal((await f.store.ensure()).mode, "rebuilt"); assert.equal((await rows(f.store))[0].row.sold, 9);
  await fs.truncate(f.file, 0); assert.equal((await f.store.ensure()).rows, 0);
  const replacement = f.file + ".replacement"; await fs.writeFile(replacement, line({ observationId: "a", companyKey: "one", sold: 0 }) + "\n"); await fs.rename(replacement, f.file);
  const same = await f.store.ensure(); assert.equal(same.mode, "rebuilt"); assert.equal(same.contentDigest, initial.contentDigest, "equal source rows reproduce the token after replacement");
});

test("source races and failed rebuild publication preserve the previous normal index transaction", async t => {
  let race = false;
  const f = await fixture(t, line({ observationId: "a", sold: 0 }) + "\n", { onBeforePublish: async () => { if (race) await fs.appendFile(f.file, "{partial\n"); } });
  const initial = await f.store.ensure(); await fs.appendFile(f.file, line({ observationId: "b" }) + "\n"); race = true;
  await assert.rejects(f.store.ensure(), { code: "HISTORY_OBSERVATION_SOURCE_CHANGED" });
  const d = new DatabaseSync(f.indexFile, { readOnly: true }), stored = JSON.parse(d.prepare("SELECT payload FROM metadata").get().payload); d.close();
  assert.equal(stored.generation, initial.generation); assert.equal(stored.rows, 1);
  race = false; assert.equal((await f.store.ensure()).mode, "rebuilt");
  await assert.rejects(f.store.readRows({}, async () => fs.appendFile(f.file, "\n")), { code: "HISTORY_OBSERVATION_SOURCE_CHANGED" });
});

test("a derived append failure never repeats source append and the next ensure rebuilds", async t => {
  let fail = false;
  const f = await fixture(t, line({ observationId: "a" }) + "\n", { onBeforePublish: async ({ mode }) => { if (fail && mode === "incremental") throw new Error("Simulated derived write failure"); } });
  const initial = await f.store.ensure(); fail = true;
  const payload = line({ observationId: "b" }) + "\n", appended = await f.store.append(payload);
  assert.equal(appended.indexed, false); assert.equal((await fs.readFile(f.file, "utf8")).split('"b"').length - 1, 1);
  fail = false; const rebuilt = await f.store.ensure(); assert.equal(rebuilt.mode, "rebuilt"); assert.equal(rebuilt.rows, initial.rows + 1);
});

test("write, sync and close uncertainty reject explicitly and are never reported as an indexed-source success", async t => {
  const native = require("node:fs");
  for (const failedStage of ["writeFile", "sync", "close"]) {
    const f = await fixture(t, line({ observationId: "a" }) + "\n"); await f.store.ensure();
    let appendWrites = 0, failed = false;
    const fileSystem = Object.create(fs);
    fileSystem.open = async (...args) => {
      const handle = await fs.open(...args);
      if (args[0] !== f.file || !(args[1] & native.constants.O_WRONLY)) return handle;
      return { stat: (...options) => handle.stat(...options),
        writeFile: async (...options) => { appendWrites++; await handle.writeFile(...options); if (failedStage === "writeFile" && !failed) { failed = true; throw Object.assign(new Error("write uncertain"), { code: "EIO" }); } },
        sync: async () => { if (failedStage === "sync" && !failed) { failed = true; throw Object.assign(new Error("sync uncertain"), { code: "EIO" }); } await handle.sync(); },
        close: async () => { await handle.close(); if (failedStage === "close" && !failed) { failed = true; throw Object.assign(new Error("close uncertain"), { code: "EIO" }); } } };
    };
    const writing = f.create({ fileSystem }), payload = line({ observationId: "b" }) + "\n";
    await assert.rejects(writing.append(payload), { code: "HISTORY_OBSERVATION_SOURCE_APPEND_UNCERTAIN" });
    assert.equal(appendWrites, 1, "an uncertain source append must not retry internally");
    const current = await f.store.ensure(); assert.equal(current.mode, "rebuilt");
    assert.equal((await f.store.findObservationIds({ observationIds: ["b"] })).existingIds.has("b"), true, "subsequent ingestion can detect bytes that did reach history");
    assert.equal((await fs.readFile(f.file, "utf8")).split('"b"').length - 1, 1);
  }
});

test("missing history is initially empty but deletion and symlinks never certify a former source as zero", async t => {
  const f = await fixture(t, null); assert.equal((await f.store.ensure()).rows, 0);
  assert.equal((await f.store.append(line({ observationId: "a" }) + "\n")).indexed, true);
  await fs.unlink(f.file); await assert.rejects(f.store.ensure(), { code: "HISTORY_OBSERVATION_SOURCE_MISSING" });
  const target = path.join(f.directory, "target.jsonl"); await fs.writeFile(target, line({ observationId: "b" }));
  try { await fs.symlink(target, f.file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  await assert.rejects(f.store.ensure(), { code: "HISTORY_OBSERVATION_SOURCE_INVALID" });
});

test("SQLite corruption and logically damaged saved headers/partitions fail closed", async t => {
  const f = await fixture(t, line({ observationId: "a", companyKey: "one", stayDate: "2026-09-01" }) + "\n");
  await f.store.ensure(); await f.store.close();
  const bytes = await fs.readFile(f.indexFile); await fs.writeFile(f.indexFile, Buffer.from("not a sqlite database"));
  await assert.rejects(f.create().ensure(), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
  assert.deepEqual(await fs.readFile(f.indexFile), Buffer.from("not a sqlite database")); await fs.writeFile(f.indexFile, bytes);
  const d = new DatabaseSync(f.indexFile); d.exec("UPDATE physical_rows SET header='{}'"); d.close();
  await assert.rejects(f.create().readHeaders({}, () => {}), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
  await fs.writeFile(f.indexFile, bytes);
  const altered = new DatabaseSync(f.indexFile); altered.exec("UPDATE raw_partitions SET row_count=999"); altered.close();
  await assert.rejects(f.create().revisionPartitions(), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
});

test("two index instances serialize appends and verify the shared current source before writing", async t => {
  const f = await fixture(t, line({ observationId: "a" }) + "\n"), second = f.create();
  await f.store.ensure(); assert.equal((await second.ensure()).mode, "unchanged");
  assert.equal((await f.store.append(line({ observationId: "b" }) + "\n")).indexed, true);
  assert.equal((await second.append(line({ observationId: "c" }) + "\n")).indexed, true);
  assert.deepEqual((await rows(f.store)).map(value => value.row.observationId), ["a", "b", "c"]);
  const before = sha(await fs.readFile(f.file));
  await assert.rejects(f.store.readRows({ month: "bad" }, () => {}), TypeError); assert.equal(sha(await fs.readFile(f.file)), before);
});

test("a competing SQLite writer fails explicitly without a second raw append", async t => {
  const f = await fixture(t, line({ observationId: "a" }) + "\n"); await f.store.ensure();
  let begin, release; const started = new Promise(resolve => { begin = resolve; }), held = new Promise(resolve => { release = resolve; });
  const first = f.create({ onBeforePublish: async ({ mode }) => { if (mode === "incremental") { begin(); await held; } } });
  const second = f.create({ busyTimeoutMs: 1 }); await first.ensure(); await second.ensure();
  const writing = first.append(line({ observationId: "b" }) + "\n"); await started;
  await assert.rejects(second.append(line({ observationId: "c" }) + "\n"), error => error.code.startsWith("HISTORY_OBSERVATION_"));
  release(); assert.equal((await writing).indexed, true);
  assert.deepEqual((await rows(first)).map(value => value.row.observationId), ["a", "b"]);
});

test("large multi-chunk UTF8/CRLF records retain byte positions and callback checkpoints", async t => {
  let checkpoints = 0;
  const entries = Array.from({ length: 520 }, (_, i) => line({ observationId: "row-" + i, companyKey: "업체", stayDate: "2026-09-01", payload: i === 2 ? "가".repeat(50000) : "" }));
  const f = await fixture(t, entries.join("\r\n"), { checkpoint: async () => { checkpoints++; } });
  await f.store.ensure(); assert.ok(checkpoints >= 4); assert.equal((await rows(f.store, { month: "2026-09" })).length, 520);
  const payload = "\n" + line({ observationId: "added", companyKey: "업체", stayDate: "2026-10-01" }) + "\n";
  assert.equal((await f.store.append(payload)).indexed, true); assert.equal((await f.store.ensure()).rows, 521);
});
