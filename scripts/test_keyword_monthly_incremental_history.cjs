"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const H = require("./lib/keyword_monthly_incremental_history.cjs");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const line = (id, month = "2026-10", extra = {}) => JSON.stringify({ observationId: "same-id", companyId: id, stayDate: month + "-20", runId: "run-1", ...extra });
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-history-test-")); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
async function rows(reader, query) { const result = []; const receipt = await reader.readRows(query, (row, ordinal) => result.push({ row, ordinal })); return { result, receipt }; }

test("new segment reservation receives actual compressed bytes and reused immutable segments are not charged again", async t => {
  const directory = await fixture(t), input = [line("a")], reservations = [];
  const beforeNewBlob = async (file, bytes) => { assert.equal(path.dirname(file), directory); await assert.rejects(fs.lstat(file), { code: "ENOENT" }); reservations.push({ file, bytes }); };
  const state = await H.append(directory, H.empty(), input, { beforeNewBlob }); assert.equal(reservations.length, 1);
  assert.equal((await fs.lstat(reservations[0].file)).size, reservations[0].bytes);
  assert.deepEqual(await H.append(directory, H.empty(), input, { beforeNewBlob }), state); assert.equal(reservations.length, 1);
});

test("denied new-segment reservation preserves the prior state and writes no partial file", async t => {
  const directory = await fixture(t), previous = H.empty(), denied = Object.assign(Error("denied"), { code: "KEYWORD_INCREMENTAL_PERSISTENT_BOUND" });
  await assert.rejects(H.append(directory, previous, [line("a")], { beforeNewBlob: async () => { throw denied; } }), error => error === denied);
  assert.deepEqual(previous, H.empty()); assert.deepEqual(await fs.readdir(directory), []);
});
test("physical line ordinals survive malformed JSON, nonobjects, BOM, CRLF and blanks", async t => {
  const directory = await fixture(t), previous = H.empty();
  const input = ["", " \r", "broken", "null", "[]", "42", "\uFEFF" + line("a") + "\r", line("a"), line("b", "2026-11")];
  const state = await H.append(directory, previous, input), reader = H.createReader({ directory, state });
  assert.deepEqual(previous, H.empty()); assert.equal(state.lastOrdinal, 9); assert.equal(state.blankLines, 2);
  assert.equal(state.malformedHistoryLines, 4); assert.equal(state.rows, 3);
  const actual = await rows(reader, {}); assert.deepEqual(actual.result.map(r => r.ordinal), [7, 8, 9]);
  assert.deepEqual(actual.result.map(r => r.row.companyId), ["a", "a", "b"]);
  assert.equal(actual.receipt.malformedHistoryLines, 4); assert.equal(reader.stats().sourceReads, 0);
  const raw = []; await reader.readLines({ month: "2026-10" }, (text, row, ordinal) => raw.push({ text, ordinal }));
  assert.deepEqual(raw, [{ text: input[6], ordinal: 7 }, { text: input[7], ordinal: 8 }]);
  assert.deepEqual(await reader.listMonths(), ["2026-11", "2026-10"]);
});
test("interleaved partitions, append batches, duplicate IDs and JSON key order stay intact", async t => {
  const directory = await fixture(t), first = '{"companyId":"a","stayDate":"2026-10-20","runId":"r","observationId":"same","v":1}',
    reordered = '{"v":2,"observationId":"same","runId":"r","stayDate":"2026-10-20","companyId":"a"}';
  const before = await H.append(directory, H.empty(), [first, line("b"), reordered]);
  const pinned = JSON.stringify(before), after = await H.append(directory, before, [first]);
  assert.equal(JSON.stringify(before), pinned); assert.equal(after.generation, 2); assert.equal(after.rows, 4);
  const reader = H.createReader({ directory, state: after }), raw = [];
  await reader.readLines({}, (text, row, ordinal) => raw.push([ordinal, text, Object.keys(row)]));
  assert.deepEqual(raw.map(r => r[0]), [1, 2, 3, 4]); assert.deepEqual(raw.map(r => r[1]), [first, line("b"), reordered, first]);
  assert.deepEqual(raw[0][2], ["companyId", "stayDate", "runId", "observationId", "v"]);
  assert.deepEqual(raw[2][2], ["v", "observationId", "runId", "stayDate", "companyId"]);
  const partitions = (await reader.revisionPartitions()).partitions, own = partitions.find(p => p.companyId === "a");
  let expected = digest(H.VERSION); for (const [ordinal, text] of [[1, first], [3, reordered], [4, first]]) expected = digest(expected + ordinal + ":" + text + "\n");
  assert.equal(own.digest, expected); assert.equal(own.count, 3); assert.deepEqual(own.runIds, ["r"]);
  partitions[0].count = 999; assert.notEqual((await reader.revisionPartitions()).partitions[0].count, 999);
  const scoped = await rows(reader, { partitionKey: own.key }); assert.deepEqual(scoped.result.map(r => r.ordinal), [1, 3, 4]);
  assert.equal((await rows(reader, { month: "2026-11" })).result.length, 0);
});
test("reference aliases match company keys, canonical IDs, place IDs and inferred place IDs", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [
    line("CMP_PLACE_123"), line("other", "2026-10", { companyKey: " ＦＯＯ ", placeId: "456" }),
    line("third", "2026-10", { place_id: "789", runId: "run-2" }), line("123")]);
  const reader = H.createReader({ directory, state });
  assert.deepEqual((await rows(reader, { refs: ["123"] })).result.map(r => r.ordinal), [1, 4]);
  assert.deepEqual((await rows(reader, { refs: new Set(["foo"]) })).result.map(r => r.ordinal), [2]);
  assert.deepEqual((await rows(reader, { refs: { canonical: ["456"], alternate: new Set(["789"]) } })).result.map(r => r.ordinal), [2, 3]);
  assert.deepEqual((await rows(reader, { refs: ["789"], runId: "run-1" })).result, []);
  assert.deepEqual((await rows(reader, { refs: [] })).result, []);
  const headers = []; await reader.readHeaders({ refs: ["789"] }, (header, ordinal) => headers.push({ header, ordinal }));
  assert.deepEqual(headers, [{ header: { companyId: "third", place_id: "789", stayDate: "2026-10-20", runId: "run-2" }, ordinal: 3 }]);
});
test("immutable segment tampering and truncation reject without changing the committed state", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [line("a")]), pinned = JSON.stringify(state);
  const segment = state.batches[0].segments[0], file = path.join(directory, segment.sha256 + ".json.gz"), original = await fs.readFile(file);
  const altered = Buffer.from(original); altered[altered.length - 5] ^= 1; await fs.writeFile(file, altered);
  await assert.rejects(rows(H.createReader({ directory, state }), {}), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  await fs.writeFile(file, original.subarray(0, original.length - 1));
  await assert.rejects(rows(H.createReader({ directory, state }), {}), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  assert.equal(JSON.stringify(state), pinned);
  await fs.writeFile(file, original); assert.equal((await rows(H.createReader({ directory, state }), {})).result.length, 1);
});
test("declared raw size and row counts bind compressed segment decoding", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [line("a")]);
  for (const field of ["count", "rawBytes"]) { const altered = structuredClone(state); altered.batches[0].segments[0][field]++;
    await assert.rejects(async () => rows(H.createReader({ directory, state: altered }), {}), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" }); }
  const files = await fs.readdir(directory); assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(await fs.readFile(path.join(directory, files[0])))), [[1, line("a")]]);
});
test("before and after read boundaries reject dependency/state drift", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [line("a")]);
  let calls = 0; const changed = Object.assign(new Error("state changed"), { code: "FIXTURE_STATE_CHANGED" });
  const reader = H.createReader({ directory, state, assertCurrent: async () => { if (++calls === 2) throw changed; } });
  await assert.rejects(rows(reader, {}), { code: "FIXTURE_STATE_CHANGED" }); assert.equal(calls, 2);
  await assert.rejects(reader.readRows({ parseMode: "append" }, () => {}), { code: "KEYWORD_INCREMENTAL_HISTORY_MODE_DENIED" });
});
test("row, state and query bounds fail closed", async t => {
  const directory = await fixture(t), previous = H.empty();
  await assert.rejects(H.append(directory, previous, ["x".repeat(1024 * 1024 + 1)]), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  assert.deepEqual(previous, H.empty());
  const tooMany = H.empty(); tooMany.partitions = Array(100001).fill({}); assert.throws(() => H.validate(tooMany), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  const tooLarge = H.empty(); tooLarge.extra = "x".repeat(H.MAX_STATE); assert.throws(() => H.validate(tooLarge), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  const state = await H.append(directory, previous, [line("a")]), reader = H.createReader({ directory, state });
  await assert.rejects(rows(reader, { refs: Array.from({ length: 4001 }, (_, i) => String(i)) }));
  await assert.rejects(rows(reader, { month: "2026-99" }));
  await assert.rejects(rows(reader, { partitionKey: "bad-key" }));
});
test("JSON-escaped physical batches split under decoded bounds instead of rejecting valid input", async t => {
  const directory = await fixture(t), escaped = line("a", "2026-10", { payload: "\\".repeat(500000) });
  assert.ok(Buffer.byteLength(escaped) < 1024 * 1024);
  const state = await H.append(directory, H.empty(), Array(8).fill(escaped));
  assert.equal(state.rows, 8); assert.ok(state.batches.length >= 2);
  for (const batch of state.batches) for (const s of batch.segments) assert.ok(s.rawBytes <= H.MAX_BATCH && s.bytes <= H.MAX_BATCH);
  assert.deepEqual((await rows(H.createReader({ directory, state }), {})).result.map(r => r.ordinal), [1, 2, 3, 4, 5, 6, 7, 8]);
});
