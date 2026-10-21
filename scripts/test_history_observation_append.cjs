"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Readable } = require("node:stream"), { spawnSync } = require("node:child_process");
const { findExistingObservationIds } = require("./lib/history_observation_append.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-candidate-ids-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("history-candidate-ids-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, "observations.jsonl") };
}

test("candidate-only matching preserves BOM, CRLF, blank/malformed-line skipping, ID types and zero-valued observations", async t => {
  const { file } = await fixture(t);
  const lines = ["\uFEFF" + JSON.stringify({ observationId: "a", sold: 0 }), "", "  ", "{partial", JSON.stringify({ observationId: "unrelated" }),
    JSON.stringify({ observationId: "a", sold: 9 }), JSON.stringify({ observationId: 7 }), JSON.stringify({ observationId: "7" }), "null", "[]", JSON.stringify({ sold: 0 })];
  await fs.writeFile(file, lines.join("\r\n"));
  const before = await fs.readFile(file);
  const value = await findExistingObservationIds({ file, observationIds: ["a", "a", "absent", "7"] });
  assert.deepEqual([...value.existingIds], ["a", "7"]);
  assert.equal(value.stats.candidateCount, 3); assert.equal(value.stats.scannedLines, 11);
  assert.equal(value.stats.blankLines, 2); assert.equal(value.stats.malformedLines, 1);
  assert.equal(value.stats.parsedRows, 8); assert.equal(value.stats.matchedRows, 3);
  assert.equal(value.stats.maxRetainedIds, 2); assert.equal(value.stats.missingFile, false);
  assert.equal(value.needsSeparator, true, "The complete last JSON object has no line separator");
  assert.deepEqual(await fs.readFile(file), before, "The helper must not write history");
});

test("large unrelated history retains only candidate IDs and yields/checkpoints every 256 physical lines", async t => {
  const { file } = await fixture(t), count = 4096;
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({ observationId: "history-" + index, payload: "x".repeat(200) }));
  lines[511] = ""; lines[1023] = "{partial";
  await fs.writeFile(file, lines.join("\n") + "\n");
  const checkpoints = []; let eventLoopTurn = false;
  setImmediate(() => { eventLoopTurn = true; });
  const ids = new Set(["history-3", "history-4000", "absent"]);
  const result = await findExistingObservationIds({ file, observationIds: ids, checkpoint: async stats => {
    checkpoints.push(stats); assert.equal(eventLoopTurn, true);
    assert.equal(stats.scannedLines % 256, 0); assert.ok(stats.maxRetainedIds <= ids.size);
  } });
  assert.deepEqual([...result.existingIds], ["history-3", "history-4000"]);
  assert.equal(result.stats.scannedLines, count); assert.equal(checkpoints.length, count / 256);
  assert.equal(result.stats.yieldCount, 16); assert.equal(result.stats.maxRetainedIds, 2);
  assert.equal(result.stats.blankLines, 1); assert.equal(result.stats.malformedLines, 1);
  assert.equal(result.needsSeparator, false);
  assert.equal(JSON.stringify(result.stats).includes("payload"), false);
  assert.equal(Object.values(result.stats).every(value => typeof value === "number" || typeof value === "boolean"), true);
});

test("an absent history is empty, while an I/O failure rejects instead of permitting duplicate append", async t => {
  const { root, file } = await fixture(t);
  const absent = await findExistingObservationIds({ file, observationIds: ["a"] });
  assert.equal(absent.existingIds.size, 0); assert.equal(absent.stats.missingFile, true); assert.equal(absent.needsSeparator, false);
  await assert.rejects(findExistingObservationIds({ file: root, observationIds: ["a"] }), error => error.code === "EISDIR" || error.code === "EPERM");
});

test("a late stream failure propagates unchanged and closes the stream after partial matches", async t => {
  const failure = Object.assign(new Error("test read failure"), { code: "EIO" });
  let supplied = false;
  const stream = new Readable({ read() {
    if (supplied) return;
    supplied = true; this.push('{"observationId":"a"}\n'); setImmediate(() => this.destroy(failure));
  } });
  t.mock.method(native, "createReadStream", () => stream);
  await assert.rejects(findExistingObservationIds({ file: "mock-history", observationIds: ["a"] }), error => error === failure);
  assert.equal(stream.closed, true); assert.equal(stream.destroyed, true);
});

test("checkpoint errors propagate, including ENOENT, and close the read stream", async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, Array.from({ length: 1024 }, (_, i) => JSON.stringify({ observationId: "a-" + i })).join("\n"));
  const original = native.createReadStream, opened = [];
  t.mock.method(native, "createReadStream", (...args) => { const stream = original(...args); opened.push(stream); return stream; });
  const failure = Object.assign(new Error("checkpoint failure"), { code: "ENOENT" });
  await assert.rejects(findExistingObservationIds({ file, observationIds: ["a-1"], checkpoint: async () => { throw failure; } }), error => error === failure);
  assert.equal(opened.length, 1); assert.equal(opened[0].closed, true);
});

test("fresh-process calls use current file contents with no process or durable candidate cache", async t => {
  const { file } = await fixture(t);
  const moduleFile = require.resolve("./lib/history_observation_append.cjs");
  const child = () => {
    const code = `require(${JSON.stringify(moduleFile)}).findExistingObservationIds({file:${JSON.stringify(file)},observationIds:['a','b']}).then(v=>process.stdout.write(JSON.stringify([...v.existingIds]))).catch(()=>{process.exitCode=1;});`;
    const run = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout);
  };
  await fs.writeFile(file, '{"observationId":"a"}\n'); assert.deepEqual(child(), ["a"]);
  await fs.writeFile(file, '{"observationId":"b"}\n'); assert.deepEqual(child(), ["b"]);
  assert.deepEqual([...(await findExistingObservationIds({ file, observationIds: ["a", "b"] })).existingIds], ["b"]);
});

test("empty candidate input avoids a history read and input validation is explicit", async t => {
  let calls = 0; t.mock.method(native, "createReadStream", () => { calls++; throw new Error("Unexpected open"); });
  const result = await findExistingObservationIds({ file: "unused", observationIds: [] });
  assert.equal(result.existingIds.size, 0); assert.equal(result.stats.skippedEmptyCandidates, true); assert.equal(result.needsSeparator, false); assert.equal(calls, 0);
  await assert.rejects(findExistingObservationIds({ file: "unused", observationIds: "a" }), TypeError);
  await assert.rejects(findExistingObservationIds({ observationIds: [] }), TypeError);
  await assert.rejects(findExistingObservationIds({ file: "unused", observationIds: [], checkpoint: true }), TypeError);
});

test("separator detection preserves complete and damaged unterminated tails without writing the source", async t => {
  const { file } = await fixture(t);
  const cases = [
    { text: "", separator: false, found: false, malformed: 0 },
    { text: '\uFEFF{"observationId":"a"}\r\n', separator: false, found: true, malformed: 0 },
    { text: '{"observationId":"a"}\n', separator: false, found: true, malformed: 0 },
    { text: '{"observationId":"a"}\r', separator: false, found: true, malformed: 0 },
    { text: '{"observationId":"a"}', separator: true, found: true, malformed: 0 },
    { text: '\uFEFF{"observationId":"a"}', separator: true, found: true, malformed: 0 },
    { text: '{"observationId":"a"}\n{"observationId":', separator: true, found: true, malformed: 1 },
    { text: '{"observationId":', separator: true, found: false, malformed: 1 },
    { text: '{"observationId":\r\n', separator: false, found: false, malformed: 1 }
  ];
  for (const value of cases) {
    await fs.writeFile(file, value.text);
    const before = await fs.readFile(file), result = await findExistingObservationIds({ file, observationIds: ["a"] });
    assert.equal(result.needsSeparator, value.separator, JSON.stringify(value.text));
    assert.equal(result.existingIds.has("a"), value.found); assert.equal(result.stats.malformedLines, value.malformed);
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test("separator detection follows the last chunk across the stream buffer boundary", async t => {
  const { file } = await fixture(t);
  const initial = '{"observationId":"a","payload":"' + "x".repeat(65536) + '"}\r\n';
  await fs.writeFile(file, initial + '{"observationId":"b"}');
  let result = await findExistingObservationIds({ file, observationIds: ["a", "b"] });
  assert.equal(result.needsSeparator, true); assert.deepEqual([...result.existingIds], ["a", "b"]);
  await fs.appendFile(file, "\r\n");
  result = await findExistingObservationIds({ file, observationIds: ["a", "b"] });
  assert.equal(result.needsSeparator, false); assert.deepEqual([...result.existingIds], ["a", "b"]);
});
