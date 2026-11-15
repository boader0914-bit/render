"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const C = require("./lib/keyword_monthly_source_copy.cjs"), { installCompressedHistory } = require("./lib/keyword_monthly_compressed_history.cjs"), cli = require("./export_keyword_monthly_source_copy.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-compressed-test-")); t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"), history = '{"companyKey":"cmp_place_1","stayDate":"2026-10-01","sold":0}\n'.repeat(12000);
  for (const [relative, bytes] of Object.entries({ "company_master/companies.json": '{"companies":{}}', "history/observations.jsonl": history, "outputs/run_1/manifest.json": '{"id":"run_1"}' })) {
    const file = path.join(source, ...relative.split("/")); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  }
  const inspection = await C.inspect({ sourceDataDir: source, scratchParent: root, historyCompression: "gzip" }), copyRoot = path.join(root, "keyword-monthly-source-compressed123");
  const copied = await C.copy({ sourceDataDir: source, scratchParent: root, historyCompression: "gzip", inspection, copyRoot });
  const capture = JSON.parse(await fs.readFile(path.join(copyRoot, "control/capture-complete.json"))), row = capture.inputFiles.find(item => item.compression === "gzip");
  t.after(async () => { for (const entry of capture.inputFiles) await fs.chmod(path.join(capture.dataDir, ...((entry.storageRelative || entry.relative).split("/"))), 0o600).catch(() => {}); });
  return { root, source, history, inspection, copied, capture, row, logical: path.join(capture.dataDir, "history/observations.jsonl"), storage: path.join(capture.dataDir, "history/observations.jsonl.gz") };
}
async function streamText(file) { let text = ""; for await (const chunk of native.createReadStream(file, { encoding: "utf8" })) text += chunk; return text; }
test("explicit gzip copy binds stored and expanded bytes, preserves source, and reserves a bounded physical copy", async t => {
  const f = await fixture(t), stored = await fs.readFile(f.storage);
  assert.equal(f.inspection.copyBytes, Buffer.byteLength(f.history) + Buffer.byteLength('{"companies":{}}'));
  assert.equal(f.inspection.physicalCopyReservationBytes, 512 * 1024 ** 2); assert.equal(f.inspection.canCopyWithReserve, true);
  assert.equal(f.inspection.sourceBodiesRead, "prepared_pointer_only_if_present"); assert.equal(f.row.storageRelative, "history/observations.jsonl.gz");
  assert.equal(f.row.sourceBytes, Buffer.byteLength(f.history)); assert.equal(f.row.sourceSha256, sha(f.history)); assert.equal(f.row.sha256, sha(stored)); assert.equal(f.row.bytes, stored.length);
  assert.equal(zlib.gunzipSync(stored).toString(), f.history); assert.ok(stored.length < f.row.sourceBytes / 20);
  assert.equal(await fs.readFile(path.join(f.source, "history/observations.jsonl"), "utf8"), f.history);
  await assert.rejects(fs.stat(f.logical), { code: "ENOENT" }); assert.equal(f.capture.bytes, f.capture.inputFiles.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(f.capture.scratch.maximumBytes, 1024 ** 3); assert.ok(f.capture.scratch.peakReservedAndAllocatedBytes < 1024 ** 3);
});
test("logical stream and stat mapping validate EOF and restore without mapping any other path", async t => {
  const f = await fixture(t), original = native.createReadStream, adapter = installCompressedHistory(f.capture.dataDir, f.capture); t.after(() => adapter.restore());
  assert.throws(() => adapter.verification(), { code: "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED" });
  await fs.access(f.logical); assert.equal((await fs.stat(f.logical)).size, f.row.sourceBytes); assert.equal((await fs.lstat(f.logical, { bigint: true })).size, BigInt(f.row.sourceBytes));
  assert.equal(native.statSync(f.logical).size, f.row.sourceBytes);
  assert.equal(await streamText(f.logical), f.history); const result = adapter.verification(); assert.equal(result.streamsVerified, 1); assert.equal(result.activeStreams, 0); assert.equal(result.verified, true);
  assert.equal(await fs.readFile(path.join(f.source, "history/observations.jsonl"), "utf8"), f.history);
  assert.throws(() => native.readFileSync(f.logical), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  assert.throws(() => native.openSync(f.logical, "r"), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  assert.throws(() => fs.readFile(f.logical), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  assert.throws(() => fs.open(f.logical, "r"), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  assert.throws(() => native.createReadStream(f.logical, { start: 0 }), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  assert.throws(() => fs.access(f.logical, native.constants.W_OK), { code: "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED" });
  adapter.restore(); adapter.restore(); assert.equal(native.createReadStream, original); await assert.rejects(fs.stat(f.logical), { code: "ENOENT" });
});
test("wrong raw digest and malformed or truncated gzip cannot produce verified EOF", async t => {
  for (const kind of ["digest", "truncated", "malformed"]) {
    const f = await fixture(t); let adapter;
    if (kind === "digest") f.row.sourceSha256 = "0".repeat(64);
    else {
      await fs.chmod(f.storage, 0o600); const original = await fs.readFile(f.storage), bytes = kind === "truncated" ? original.subarray(0, original.length - 6) : Buffer.alloc(40, 7);
      await fs.writeFile(f.storage, bytes); f.row.bytes = bytes.length; f.row.sha256 = sha(bytes);
    }
    try { adapter = installCompressedHistory(f.capture.dataDir, f.capture); await assert.rejects(streamText(f.logical)); assert.throws(() => adapter.verification(), { code: "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED" }); }
    finally { adapter?.restore(); }
  }
});
test("stored SHA mismatch and expanded-byte mismatch fail independently", async t => {
  for (const field of ["sha256", "sourceBytes"]) {
    const f = await fixture(t); f.row[field] = field === "sha256" ? "0".repeat(64) : 1;
    const adapter = installCompressedHistory(f.capture.dataDir, f.capture);
    try { await assert.rejects(streamText(f.logical)); assert.throws(() => adapter.verification(), { code: "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED" }); }
    finally { adapter.restore(); }
  }
});
test("readline consumes the exact logical UTF-8 rows without bypassing EOF verification", async t => {
  const f = await fixture(t), adapter = installCompressedHistory(f.capture.dataDir, f.capture), readline = require("node:readline");
  try {
    const stream = native.createReadStream(f.logical, { encoding: "utf8", highWaterMark: 64 * 1024 }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    stream.on("error", error => lines.emit("error", error)); let rows = 0;
    for await (const line of lines) { assert.equal(JSON.parse(line).sold, 0); rows++; }
    assert.equal(rows, 12000); assert.equal(adapter.verification().streamsVerified, 1);
  } finally { adapter.restore(); }
});
test("partial reads, modified storage and unsafe manifest bindings never verify", async t => {
  const f = await fixture(t), originalEntry = { ...f.row };
  f.row.storageRelative = "../observations.jsonl.gz";
  assert.throws(() => installCompressedHistory(f.capture.dataDir, f.capture), { code: "KEYWORD_COMPRESSED_HISTORY_MANIFEST_INVALID" }); Object.assign(f.row, originalEntry);
  let adapter = installCompressedHistory(f.capture.dataDir, f.capture);
  try {
    for await (const chunk of native.createReadStream(f.logical)) { assert.ok(chunk.length); break; }
    assert.throws(() => adapter.verification(), { code: "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED" });
  } finally { adapter.restore(); }
  adapter = installCompressedHistory(f.capture.dataDir, f.capture);
  try {
    await fs.chmod(f.storage, 0o600); await fs.appendFile(f.storage, "x");
    assert.throws(() => native.createReadStream(f.logical), { code: "KEYWORD_COMPRESSED_HISTORY_STORAGE_CHANGED" });
    assert.throws(() => adapter.verification(), { code: "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED" });
  } finally { adapter.restore(); }
});
test("raw default remains required by matching inspection and compression cannot be silently enabled", async t => {
  const f = await fixture(t);
  await assert.rejects(C.copy({ sourceDataDir: f.source, inspection: f.inspection, copyRoot: path.join(f.root, "keyword-monthly-source-other123") }), { code: "KEYWORD_COPY_COMPRESSION_MISMATCH" });
  await assert.rejects(C.inspect({ sourceDataDir: f.source, historyCompression: "zip" }), { code: "KEYWORD_COPY_COMPRESSION_INVALID" });
  assert.throws(() => cli.args(["--mode", "inspect", "--source-data", f.source, "--history-compression", "zip"]), /ARGUMENTS/);
  assert.equal(cli.args(["--mode", "inspect", "--source-data", f.source, "--history-compression", "gzip"])["history-compression"], "gzip");
});
test("metadata-only gzip admission permits larger raw total but rejects nonhistory or raw-history bounds", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-compressed-bounds-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ["company_master", "history", "outputs"]) await fs.mkdir(path.join(root, directory));
  const company = await fs.open(path.join(root, "company_master/companies.json"), "wx"), history = await fs.open(path.join(root, "history/observations.jsonl"), "wx");
  try {
    await company.truncate(120 * 1024 ** 2); await history.truncate(450 * 1024 ** 2);
    const raw = await C.inspect({ sourceDataDir: root, scratchParent: root }), compressed = await C.inspect({ sourceDataDir: root, scratchParent: root, historyCompression: "gzip" });
    assert.equal(raw.canCopyWithReserve, false); assert.equal(compressed.canCopyWithReserve, true); assert.equal(compressed.copyBytes, 570 * 1024 ** 2);
    await company.truncate(512 * 1024 ** 2); assert.equal((await C.inspect({ sourceDataDir: root, scratchParent: root, historyCompression: "gzip" })).canCopyWithReserve, false);
    await history.truncate(512 * 1024 ** 2 + 1); await assert.rejects(C.inspect({ sourceDataDir: root, scratchParent: root, historyCompression: "gzip" }), { code: "KEYWORD_COPY_FILE_BOUND" });
  } finally { await company.close(); await history.close(); }
});
