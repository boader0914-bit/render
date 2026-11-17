"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const H = require("./lib/keyword_monthly_incremental_history.cjs");
const P = require("./lib/keyword_monthly_refresh_preparation.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const token = v => String(v || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-history-refs-"));
  t.after(async () => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("incremental-history-refs-")); await fs.rm(resolved, { recursive: true, force: true }); });
  return directory;
}
async function snapshot(directory) {
  return Promise.all((await fs.readdir(directory)).sort().map(async name => {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    return { name, sha256: sha(await fs.readFile(file)), bytes: stat.size, nlink: stat.nlink, mtimeMs: stat.mtimeMs };
  }));
}
async function countBlobReads(directory, operation) {
  const original = fs.readFile, files = [];
  fs.readFile = async function (file, ...args) {
    if (typeof file === "string" && path.dirname(file) === directory && file.endsWith(".json.gz")) files.push(file);
    return original.call(this, file, ...args);
  };
  try { return { value: await operation(), files }; } finally { fs.readFile = original; }
}
// The former full-scan selection contract, kept independent of the new
// metadata prefilter. Valid fixture blobs retain their physical source order.
async function oldFullScan(directory, state, query, kind) {
  const q = query || {}, refs = q.refs === undefined ? null : new Set((Array.isArray(q.refs) || q.refs instanceof Set ? [...q.refs]
    : Object.values(q.refs).flatMap(v => Array.isArray(v) || v instanceof Set ? [...v] : [v])).map(token));
  const matches = row => {
    if (q.runId !== undefined && String(row.runId || "") !== String(q.runId)) return false;
    if (!refs) return true;
    const key = token(row.companyKey || row.companyId), inferred = key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : "");
    return [row.companyKey, row.companyId, row.placeId, row.place_id, inferred].map(token).some(x => refs.has(x));
  };
  const output = [];
  for (const batch of state.batches) {
    const rows = [];
    for (const s of batch.segments) {
      if (q.month !== undefined && s.month !== q.month || q.partitionKey !== undefined && s.key !== q.partitionKey) continue;
      const file = path.join(directory, s.sha256 + ".json.gz"), before = await P.checked(file), bytes = await fs.readFile(file);
      assert.equal(bytes.length, s.bytes); assert.equal(sha(bytes), s.sha256); assert.ok(P.same(before, await P.checked(file)));
      const raw = zlib.gunzipSync(bytes, { maxOutputLength: H.MAX_BATCH }); assert.equal(raw.length, s.rawBytes);
      const parsed = JSON.parse(raw); assert.equal(parsed.length, s.count); rows.push(...parsed);
    }
    rows.sort((a, b) => a[0] - b[0]);
    for (const [ordinal, line] of rows) {
      const row = JSON.parse(line.replace(/^\uFEFF/, "")); if (!matches(row)) continue;
      if (kind === "headers") output.push({ ordinal, header: Object.fromEntries(["companyKey", "companyId", "placeId", "place_id", "stayDate", "date", "runId"]
        .filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]])) });
      else if (kind === "lines") output.push({ ordinal, line, row }); else output.push({ ordinal, row });
    }
  }
  return { output, digest: sha(JSON.stringify(output)), selectedRows: output.length };
}
async function optimized(directory, state, query, kind) {
  const reader = H.createReader({ directory, state }), output = [];
  let activeConsumers = 0;
  const consume = async item => { activeConsumers++; assert.equal(activeConsumers, 1); await new Promise(resolve => setImmediate(resolve)); output.push(item); activeConsumers--; };
  const receipt = kind === "headers" ? await reader.readHeaders(query, (header, ordinal) => consume({ ordinal, header }))
    : kind === "lines" ? await reader.readLines(query, (line, row, ordinal) => consume({ ordinal, line, row }))
      : await reader.readRows(query, (row, ordinal) => consume({ ordinal, row }));
  return { output, digest: sha(JSON.stringify(output)), selectedRows: receipt.selectedRows, receipt, stats: reader.stats() };
}

test("metadata refs preserve full-scan ordered rows, raw lines and headers across companies, months, aliases and numeric values", async t => {
  const directory = await fixture(t), encode = row => JSON.stringify(row);
  const lines = ["", "broken", "null", "\uFEFF" + encode({ companyId: "CMP_PLACE_123", stayDate: "2026-10-02", runId: "r1", sold: null, supply: 0 }) + "\r",
    encode({ companyKey: " ＦＯＯ ", companyId: "other", placeId: 456, place_id: "789", date: "2026-10-03", runId: "r2", v: 0 }),
    '{"v":2,"runId":"r1","stayDate":"2026-10-04","companyId":"CMP_PLACE_123"}',
    encode({ companyKey: 0, companyId: "cmp_place_987", placeId: 0, place_id: null, stayDate: "2026-10-04", runId: 0 }),
    encode({ companyKey: false, companyId: 123, placeId: "456", stayDate: "2026-11-05", runId: "0" }),
    encode({ companyId: "elsewhere", stayDate: "2026-10-08", runId: "r1" }),
    encode({ companyId: 0, date: "2026-11-05", runId: "" }), encode({ companyId: "undated", stayDate: "bad", runId: "r3" })];
  let state = await H.append(directory, H.empty(), lines);
  state = await H.append(directory, state, [lines[3], encode({ companyId: "elsewhere", stayDate: "2026-11-10", runId: "r2" })]);
  const pinned = JSON.stringify(state), before = await snapshot(directory), own = state.partitions.find(p => p.companyId === "CMP_PLACE_123" && p.month === "2026-10");
  const queries = [{}, { month: "2026-10" }, { refs: ["123"] }, { month: "2026-10", refs: ["123"] }, { refs: new Set(["foo"]) },
    { refs: { canonical: [456], alternate: new Set(["789"]) } }, { refs: ["987"] }, { refs: [0] }, { refs: [null] }, { refs: [""] }, { refs: [] }, { refs: {} },
    { refs: 123 }, { refs: ["123"], runId: "r1" }, { refs: ["123"], runId: "0" }, { refs: [0], runId: 0 }, { refs: [0], runId: "" },
    { partitionKey: own.key, refs: ["123"] }, { partitionKey: own.key, refs: ["unrelated"] }, { month: "2026-12", refs: ["123"] }];
  for (const query of queries) for (const kind of ["rows", "lines", "headers"]) {
    const old = await countBlobReads(directory, () => oldFullScan(directory, state, query, kind));
    const fresh = await countBlobReads(directory, () => optimized(directory, state, query, kind));
    assert.deepEqual(fresh.value.output, old.value.output, JSON.stringify({ query, kind }));
    assert.equal(fresh.value.digest, old.value.digest); assert.equal(fresh.value.selectedRows, old.value.selectedRows);
    assert.equal(fresh.value.receipt.contentDigest, sha(pinned)); assert.equal(fresh.value.receipt.source.signature, sha(pinned));
    assert.equal(fresh.value.stats.segmentReads, fresh.files.length); assert.ok(fresh.files.length <= old.files.length);
    if (query.refs && (Array.isArray(query.refs) && query.refs.length === 0 || query.partitionKey && query.refs[0] === "unrelated")) assert.equal(fresh.files.length, 0);
  }
  const old = await countBlobReads(directory, () => oldFullScan(directory, state, { month: "2026-10", refs: ["123"] }, "lines"));
  const fresh = await countBlobReads(directory, () => optimized(directory, state, { month: "2026-10", refs: ["123"] }, "lines"));
  assert.ok(fresh.files.length > 0 && fresh.files.length < old.files.length);
  assert.equal(old.files.length, 5); assert.equal(fresh.files.length, 2);
  t.diagnostic("same ordered line/header/row digests: 20 queries × 3 kinds; scoped blob fs.readFile calls 5→2");
  assert.equal(JSON.stringify(state), pinned); assert.deepEqual(await snapshot(directory), before);
});

test("all partition and segment metadata must agree before even an empty or unrelated ref query can skip blobs", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [JSON.stringify({ companyId: "a", stayDate: "2026-10-01" })]);
  const cases = [s => { s.partitions[0].companyId = "hidden"; }, s => { s.partitions[0].month = "2026-11"; },
    s => { s.batches[0].segments[0].key = "a".repeat(64); }, s => { s.batches[0].segments[0].month = "2026-11"; },
    s => { s.partitions[0].count++; }, s => { s.batches[0].segments[0].count++; },
    s => { s.batches[0].segments[0].bytes += .5; }, s => { s.batches[0].segments[0].rawBytes += .5; },
    s => { s.rows = 2; s.lastOrdinal = 3; s.partitions[0].count = 2; s.batches[0].segments[0].count = 2; }];
  for (const alter of cases) for (const refs of [[], ["unrelated"]]) {
    const invalid = structuredClone(state); alter(invalid);
    const checked = await countBlobReads(directory, async () => {
      await assert.rejects(async () => optimized(directory, invalid, { refs }, "rows"), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
    });
    assert.equal(checked.files.length, 0);
  }
});

test("numeric overflow and opaque reference headers keep former matching and run-filter error behavior after JSON metadata persistence", async t => {
  const directory = await fixture(t), lines = ['{"companyId":1e999,"stayDate":"2026-10-01","runId":"overflow"}',
    '{"companyId":-1e999,"stayDate":"2026-10-02","runId":"negative"}',
    '{"companyId":null,"stayDate":"2026-10-03","runId":"null"}',
    '{"companyId":[1e999,"x"],"stayDate":"2026-10-04","runId":"array"}',
    '{"companyId":{"toString":"not-callable"},"stayDate":"2026-10-05","runId":"opaque"}'];
  const state = JSON.parse(JSON.stringify(await H.append(directory, H.empty(), lines)));
  for (const query of [{ refs: ["infinity"], runId: "overflow" }, { refs: ["-infinity"], runId: "negative" },
    { refs: ["infinity,x"], runId: "array" }, { refs: [0], runId: "null" }, { refs: [], runId: "not-present" }]) {
    const old = await oldFullScan(directory, state, query, "lines"), fresh = await optimized(directory, state, query, "lines");
    assert.deepEqual(fresh.output, old.output); assert.equal(fresh.digest, old.digest); assert.equal(fresh.selectedRows, old.selectedRows);
  }
  await assert.rejects(oldFullScan(directory, state, { refs: [], runId: "opaque" }, "rows"), TypeError);
  await assert.rejects(optimized(directory, state, { refs: [], runId: "opaque" }, "rows"), TypeError);
});

test("a forged segment pointing to valid foreign row bytes cannot bypass the requested partition binding", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [JSON.stringify({ companyId: "a", stayDate: "2026-10-01" })]);
  const key = state.partitions[0].key;
  for (const forgedRows of [[[1, JSON.stringify({ companyId: "b", stayDate: "2026-10-01" })]], [[1, JSON.stringify({ companyId: "a", stayDate: "2026-11-01" })]],
    [[99, JSON.stringify({ companyId: "a", stayDate: "2026-10-01" })]]]) {
    const raw = Buffer.from(JSON.stringify(forgedRows)), blob = await H.writeBlob(directory, zlib.gzipSync(raw)), invalid = structuredClone(state);
    Object.assign(invalid.batches[0].segments[0], blob, { rawBytes: raw.length });
    assert.equal(invalid.batches[0].segments[0].key, key);
    await assert.rejects(optimized(directory, invalid, { refs: ["a"] }, "rows"), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  }
});

test("selected blob tampering and hardlinks still fail closed and successful scoped reads never modify original files", async t => {
  const directory = await fixture(t), state = await H.append(directory, H.empty(), [JSON.stringify({ companyId: "a", stayDate: "2026-10-01" })]);
  const segment = state.batches[0].segments[0], file = path.join(directory, segment.sha256 + ".json.gz"), original = await fs.readFile(file);
  const changed = Buffer.from(original); changed[changed.length - 4] ^= 1; await fs.writeFile(file, changed);
  await assert.rejects(optimized(directory, state, { refs: ["a"] }, "rows"), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" });
  await fs.writeFile(file, original); const link = path.join(directory, "owned-fixture-link"); await fs.link(file, link);
  await assert.rejects(optimized(directory, state, { refs: ["a"] }, "rows"), { code: "KEYWORD_MONTHLY_REFRESH_PATH_UNSAFE" });
  await fs.unlink(link); const before = await snapshot(directory);
  assert.equal((await optimized(directory, state, { refs: ["a"] }, "rows")).selectedRows, 1);
  assert.deepEqual(await snapshot(directory), before);
});
