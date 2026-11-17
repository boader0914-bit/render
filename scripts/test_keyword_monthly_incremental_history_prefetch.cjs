"use strict";
// Synthetic saved files only. The frozen 30dd reader is the serial oracle.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs");
const path = require("node:path"), os = require("node:os"), vm = require("node:vm"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { createRequire } = require("node:module");
const H = require("./lib/keyword_monthly_incremental_history.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
// Normalize checkout EOL in this CODE fixture only. History JSON/raw lines and
// the runtime candidate remain byte-exact; Git 30dd stores this source as LF.
const oldSource = Buffer.from(native.readFileSync(path.join(__dirname, "fixtures/keyword-monthly-history-serial-30dd.fixture.cjs"), "utf8").replace(/\r\n/g, "\n"));
assert.equal(hash(oldSource), "3a938ea65f26ca2c803dbff40d839434fb90263c6022361ed8e226bafb674ea7");
const oldModule = { exports: {} };
vm.runInNewContext(oldSource.toString("utf8"), { module: oldModule, exports: oldModule.exports,
  require: createRequire(path.join(__dirname, "lib/keyword_monthly_incremental_history.cjs")),
  Buffer, structuredClone, Set, Map, process: { platform: process.platform } }, { filename: "frozen-serial-30dd.cjs" });
const OLD = oldModule.exports;

async function fixture(t, secondBatch = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-prefetch-synthetic-"));
  t.after(async () => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("history-prefetch-synthetic-")); await fs.rm(resolved, { recursive: true, force: true }); });
  const line = (company, month, extra = {}) => JSON.stringify({ companyId: company, stayDate: month + "-20", runId: "synthetic-run-a", value: null, supply: 0, ...extra });
  const lines = ["", "broken", "null", "\uFEFF" + line("cmp_place_1", "2026-11") + "\r", line("b", "2026-11", { placeId: 2 }),
    '{"value":false,"runId":"synthetic-run-b","date":"2026-11-21","companyKey":" ＡＬＩＡＳ ","place_id":"3"}',
    line("d", "2026-11"), line("e", "2026-11"), line("f", "2026-12"), line("g", "2026-12"), line("h", "2026-11")];
  let state = await H.append(directory, H.empty(), lines);
  if (secondBatch) state = await H.append(directory, state, [line("b", "2026-11", { runId: "synthetic-run-b", value: 7 }), line("f", "2026-12", { runId: "synthetic-run-b" })]);
  return { directory, state };
}
async function collect(reader, query, kind = "rows", callback = null) {
  const output = []; let active = 0;
  const consume = async value => { active++; assert.equal(active, 1); if (callback) await callback(value); await Promise.resolve(); output.push(structuredClone(value)); active--; };
  const receipt = kind === "rows" ? await reader.readRows(query, (row, ordinal) => consume({ row, ordinal, keys: Object.keys(row) }))
    : kind === "headers" ? await reader.readHeaders(query, (header, ordinal) => consume({ header, ordinal }))
      : await reader.readLines(query, (line, row, ordinal) => consume({ line, row, ordinal, keys: Object.keys(row) }));
  return { output, receipt: structuredClone(receipt), stats: structuredClone(reader.stats()) };
}
async function inspectFiles(directory) {
  return Promise.all((await fs.readdir(directory)).sort().map(async name => { const p = path.join(directory, name), s = await fs.lstat(p);
    return { name, sha256: hash(await fs.readFile(p)), bytes: s.size, mtimeMs: s.mtimeMs, nlink: s.nlink }; }));
}
async function instrument(directory, operation, readBehavior = async ({ read }) => read()) {
  const original = fs.readFile, decode = zlib.gunzipSync;
  const info = { active: 0, maximum: 0, started: [], settled: [], decoded: [] };
  fs.readFile = async function (file, ...args) {
    if (typeof file !== "string" || path.dirname(file) !== directory || !file.endsWith(".json.gz")) return original.call(this, file, ...args);
    const id = path.basename(file, ".json.gz"); info.active++; info.maximum = Math.max(info.maximum, info.active); info.started.push(id);
    try { return await readBehavior({ id, file, index: info.started.length - 1, read: () => original.call(this, file, ...args), info }); }
    finally { info.active--; info.settled.push(id); }
  };
  zlib.gunzipSync = (bytes, ...args) => { info.decoded.push(hash(bytes)); return decode(bytes, ...args); };
  try { return { value: await operation(info), info }; }
  finally { fs.readFile = original; zlib.gunzipSync = decode; }
}

test("refs-free full-month and unscoped queries preserve serial rows/headers/raw lines, counts and all stats", async t => {
  const f = await fixture(t), before = await inspectFiles(f.directory), pinned = JSON.stringify(f.state);
  const queries = [{ month: "2026-11" }, { month: "2026-12" }, {}, { month: "2026-11", runId: "synthetic-run-b" },
    { month: "2026-11", refs: ["1", "2", "alias"] }, { refs: [] }, { partitionKey: f.state.partitions.find(p => p.companyId === "b" && p.month === "2026-11").key }];
  for (const q of queries) for (const kind of ["rows", "headers", "lines"]) {
    const old = await collect(OLD.createReader({ directory: f.directory, state: f.state }), q, kind);
    const fresh = await collect(H.createReader({ directory: f.directory, state: f.state }), q, kind);
    assert.deepEqual(fresh, old, JSON.stringify({ q, kind }));
    assert.equal(hash(JSON.stringify(fresh.output)), hash(JSON.stringify(old.output)));
  }
  assert.equal(JSON.stringify(f.state), pinned); assert.deepEqual(await inspectFiles(f.directory), before);
});
test("async reads overlap at exactly two while decode order and physical callback order remain serial", async t => {
  const f = await fixture(t, false), expectedSegments = f.state.batches[0].segments.filter(s => s.month === "2026-11").map(s => s.sha256);
  const both = deferred();
  const old = await collect(OLD.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }, "lines");
  const run = await instrument(f.directory, () => collect(H.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }, "lines"),
    async ({ id, info, read }) => { if (info.started.length === 2) both.resolve(); const bytes = await read(); await both.promise; await pause(id === expectedSegments[0] ? 35 : 2); return bytes; });
  assert.deepEqual(run.value, old); assert.equal(run.info.maximum, 2); assert.equal(run.info.active, 0);
  assert.deepEqual([...run.info.started].sort(), [...expectedSegments].sort()); assert.deepEqual(run.info.decoded, expectedSegments);
  assert.notEqual(run.info.settled[0], expectedSegments[0]);
  const ordinals = run.value.output.map(r => r.ordinal); assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
});
test("the same reader shares its two payload leases across overlapping full and refs queries", async t => {
  const f = await fixture(t), reader = H.createReader({ directory: f.directory, state: f.state });
  const q = [{ month: "2026-11" }, { month: "2026-12" }, { month: "2026-11", refs: ["1", "2"] }];
  const expected = await Promise.all(q.map(query => collect(OLD.createReader({ directory: f.directory, state: f.state }), query)));
  const run = await instrument(f.directory, () => Promise.all(q.map(query => collect(reader, query))), async ({ read }) => { const bytes = await read(); await pause(3); return bytes; });
  assert.equal(run.info.maximum, 2); assert.equal(run.info.active, 0); assert.equal(run.info.started.length, run.info.settled.length);
  run.value.forEach((actual, i) => { assert.deepEqual(actual.output, expected[i].output); assert.equal(actual.receipt.selectedRows, expected[i].receipt.selectedRows); });
  assert.equal(reader.stats().segmentReads, expected.reduce((n, r) => n + r.stats.segmentReads, 0));
  assert.equal(reader.stats().segmentBytes, expected.reduce((n, r) => n + r.stats.segmentBytes, 0));
});
test("a faster later read error never replaces the first index error and all started reads drain", async t => {
  const f = await fixture(t, false), a = Object.assign(Error("synthetic-first"), { code: "SYNTHETIC_FIRST" }), b = Object.assign(Error("synthetic-second"), { code: "SYNTHETIC_SECOND" });
  const selected = f.state.batches[0].segments.filter(s => s.month === "2026-11"), both = deferred();
  const run = await instrument(f.directory, async info => {
    await assert.rejects(collect(H.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }), e => e === a);
    assert.equal(info.active, 0); assert.equal(info.started.length, 2); assert.equal(info.settled.length, 2);
    await pause(10); assert.equal(info.started.length, 2); return true;
  }, async ({ id, info }) => { if (info.started.length === 2) both.resolve(); await both.promise; await pause(id === selected[0].sha256 ? 25 : 2); throw id === selected[0].sha256 ? a : b; });
  assert.equal(run.info.maximum, 2);
});
test("observed second-index failure stops replacements while the earlier successful segment keeps serial stats", async t => {
  const f = await fixture(t, false), error = Object.assign(Error("synthetic-second"), { code: "SYNTHETIC_SECOND" }), reader = H.createReader({ directory: f.directory, state: f.state });
  const selected = f.state.batches[0].segments.filter(s => s.month === "2026-11"), both = deferred();
  const run = await instrument(f.directory, async () => { await assert.rejects(collect(reader, { month: "2026-11" }), e => e === error); },
    async ({ id, info, read }) => { if (info.started.length === 2) both.resolve(); await both.promise; if (id === selected[1].sha256) { await pause(2); throw error; } const bytes = await read(); await pause(25); return bytes; });
  assert.equal(run.info.started.length, 2); assert.equal(run.info.active, 0); assert.equal(reader.stats().segmentReads, 1);
  assert.equal(reader.stats().segmentBytes, f.state.batches[0].segments.filter(s => s.month === "2026-11")[0].bytes);
  assert.equal(reader.stats().rowsRead, 0);
  assert.equal((await collect(reader, { month: "2026-12" })).receipt.selectedRows, 2);
});
test("corruption in the earlier compressed payload holds and drains the later in-flight read", async t => {
  const f = await fixture(t, false), reader = H.createReader({ directory: f.directory, state: f.state });
  const first = f.state.batches[0].segments.find(s => s.month === "2026-11").sha256, both = deferred();
  const run = await instrument(f.directory, async info => { await assert.rejects(collect(reader, { month: "2026-11" }), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" }); assert.equal(info.active, 0); },
    async ({ id, info, read }) => { if (info.started.length === 2) both.resolve(); const bytes = await read(); await both.promise; if (id === first) { const bad = Buffer.from(bytes); bad[0] ^= 1; return bad; } await pause(30); return bytes; });
  assert.equal(run.info.started.length, 2); assert.equal(run.info.settled.length, 2); assert.equal(reader.stats().segmentReads, 0);
});
test("an earlier invalid ordinal decode wins over a prefetched later read error, without launching beyond the window", async t => {
  const f = await fixture(t, false), selected = f.state.batches[0].segments.filter(s => s.month === "2026-11"), target = selected[1];
  const raw = Buffer.from(JSON.stringify([[99999, JSON.stringify({ companyId: "b", stayDate: "2026-11-20" })]]));
  const blob = await H.writeBlob(f.directory, zlib.gzipSync(raw)); Object.assign(target, blob, { rawBytes: raw.length });
  const later = Object.assign(Error("later"), { code: "SYNTHETIC_LATER" }), third = deferred();
  const run = await instrument(f.directory, async info => { await assert.rejects(collect(H.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" }); assert.equal(info.active, 0); },
    async ({ id, read }) => { if (id === selected[2].sha256) { third.resolve(); throw later; } const bytes = await read(); if (id === target.sha256) { await third.promise; await pause(5); } return bytes; });
  assert.equal(run.info.started.length, 3); assert.equal(run.info.started.length, run.info.settled.length);
});
test("H.checked after-read still detects a real synthetic leaf change before any later replacement", async t => {
  const f = await fixture(t, false), first = f.state.batches[0].segments.find(s => s.month === "2026-11").sha256, both = deferred();
  const run = await instrument(f.directory, async info => { await assert.rejects(collect(H.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }), { code: "KEYWORD_INCREMENTAL_HISTORY_INVALID" }); assert.equal(info.active, 0); },
    async ({ id, info, file, read }) => { if (info.started.length === 2) both.resolve(); const bytes = await read(); await both.promise; if (id === first) await fs.appendFile(file, "synthetic-change"); else await pause(20); return bytes; });
  assert.equal(run.info.started.length, 2); assert.equal(run.info.started.length, run.info.settled.length);
});
test("consumer failure starts no later batch, leaves no pending I/O, and releases leases for later reads", async t => {
  const f = await fixture(t), reader = H.createReader({ directory: f.directory, state: f.state }), failure = Error("synthetic-consumer");
  const expectedReads = f.state.batches[0].segments.filter(s => s.month === "2026-11").length;
  const run = await instrument(f.directory, async info => { await assert.rejects(collect(reader, { month: "2026-11" }, "rows", () => { throw failure; }), e => e === failure); assert.equal(info.active, 0); },
    async ({ read }) => { const bytes = await read(); await pause(2); return bytes; });
  assert.equal(run.info.started.length, expectedReads); assert.equal(reader.stats().rowsRead, 0);
  assert.equal((await collect(reader, { month: "2026-12" })).receipt.selectedRows, 3);
});
test("failure across overlapping queries drains reader leases without stranded rejections", async t => {
  const f = await fixture(t, false), reader = H.createReader({ directory: f.directory, state: f.state }), failure = Error("synthetic-shared");
  const first = f.state.batches[0].segments.find(s => s.month === "2026-11").sha256;
  const unhandled = [], listener = e => unhandled.push(e); process.on("unhandledRejection", listener);
  try {
    const run = await instrument(f.directory, async () => {
      const done = await Promise.allSettled([collect(reader, { month: "2026-11" }), collect(reader, { month: "2026-12" })]);
      assert.equal(done[0].status, "rejected"); assert.equal(done[0].reason, failure); assert.equal(done[1].status, "fulfilled");
      assert.equal(done[1].value.receipt.selectedRows, 2); return done;
    }, async ({ id, read }) => { if (id === first) { await pause(8); throw failure; } const bytes = await read(); await pause(2); return bytes; });
    assert.equal(run.info.active, 0); assert.equal(run.info.maximum, 2); assert.equal(run.info.started.length, run.info.settled.length);
    await pause(10); assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", listener); }
});

test("all falsy read rejections preserve the first original value and drain the later read", async t => {
  const f = await fixture(t, false), selected = f.state.batches[0].segments.filter(s => s.month === "2026-11");
  for (const reason of [0, null, undefined, false, ""]) {
    const both = deferred(), reader = H.createReader({ directory: f.directory, state: f.state }); let rejected = false, caught;
    const run = await instrument(f.directory, async info => {
      try { await collect(reader, { month: "2026-11" }); } catch (error) { rejected = true; caught = error; }
      assert.equal(rejected, true); assert.equal(caught, reason); assert.equal(info.active, 0);
      assert.equal(info.started.length, 2); assert.equal(info.settled.length, 2);
    }, async ({ id, info }) => {
      if (info.started.length === 2) both.resolve(); await both.promise;
      if (id === selected[0].sha256) { await pause(15); throw reason; }
      await pause(1); throw Error("synthetic-later");
    });
    assert.equal(run.info.maximum, 2); assert.equal(reader.stats().segmentReads, 0);
  }
});

test("valid SHA/gzip with invalid raw JSON keeps the earliest SyntaxError across a later native error and queued query", async t => {
  const f = await fixture(t, false), selected = f.state.batches[0].segments.filter(s => s.month === "2026-11"), raw = Buffer.from("{synthetic-invalid-json");
  const blob = await H.writeBlob(f.directory, zlib.gzipSync(raw)); Object.assign(selected[0], blob, { rawBytes: raw.length });
  let expected; try { await collect(OLD.createReader({ directory: f.directory, state: f.state }), { month: "2026-11" }); } catch (e) { expected = e; }
  assert.equal(expected?.name, "SyntaxError");
  const reader = H.createReader({ directory: f.directory, state: f.state }), both = deferred(), unhandled = [], listener = e => unhandled.push(e);
  process.on("unhandledRejection", listener);
  try {
    const run = await instrument(f.directory, async () => {
      const done = await Promise.allSettled([collect(reader, { month: "2026-11" }), collect(reader, { month: "2026-12" })]);
      assert.equal(done[0].status, "rejected"); assert.equal(done[0].reason.name, expected.name); assert.equal(done[0].reason.message, expected.message);
      assert.equal(done[1].status, "fulfilled"); assert.equal(done[1].value.receipt.selectedRows, 2);
    }, async ({ id, info, read }) => {
      if (info.started.length === 2) both.resolve();
      if (id === selected[0].sha256) { const bytes = await read(); await both.promise; await pause(15); return bytes; }
      if (id === selected[1].sha256) { await both.promise; await pause(1); throw Object.assign(Error("synthetic-native"), { code: "EIO" }); }
      return read();
    });
    assert.equal(run.info.maximum, 2); assert.equal(run.info.active, 0); assert.equal(run.info.started.length, run.info.settled.length);
    assert.equal(run.info.started.filter(id => selected.some(s => s.sha256 === id)).length, 2);
    await pause(5); assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", listener); }
});

test("two loaded payload leases block a queued query while ordered post-check/decode is paused", async t => {
  const P = require("./lib/keyword_monthly_refresh_preparation.cjs"), f = await fixture(t, false), originalChecked = P.checked;
  const first = f.state.batches[0].segments.find(s => s.month === "2026-11").sha256, entered = deferred(), release = deferred(), counts = new Map();
  const reader = H.createReader({ directory: f.directory, state: f.state }); let a, b;
  P.checked = async function (file, directory) {
    const result = await originalChecked(file, directory);
    if (!directory && path.basename(file, ".json.gz") === first) {
      const count = (counts.get(file) || 0) + 1; counts.set(file, count);
      if (count === 2) { entered.resolve(); await release.promise; }
    }
    return result;
  };
  try {
    const run = await instrument(f.directory, async info => {
      a = collect(reader, { month: "2026-11" }); await entered.promise;
      while (info.settled.length < 2) await pause(1);
      assert.equal(info.active, 0); assert.equal(info.started.length, 2); assert.equal(info.decoded.length, 0);
      b = collect(reader, { month: "2026-12" }); await pause(15);
      assert.equal(info.started.length, 2, "loaded payloads must keep both leases even after fs.readFile finishes");
      assert.equal(info.active, 0); release.resolve(); return Promise.all([a, b]);
    }, async ({ read }) => { const bytes = await read(); await pause(2); return bytes; });
    assert.equal(run.info.maximum, 2); assert.equal(run.info.active, 0); assert.equal(run.info.started.length, run.info.settled.length);
    assert.equal(run.value[0].receipt.selectedRows, 6); assert.equal(run.value[1].receipt.selectedRows, 2);
  } finally { release.resolve(); P.checked = originalChecked; await Promise.allSettled([a, b].filter(Boolean)); }
});

test("real normalizePair keyword → monthly loadSources uses refs-free full months and preserves every normalized/financial snapshot field", async t => {
  const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
  const { createIncrementalCatalog } = require("./lib/keyword_monthly_incremental_catalog.cjs");
  const { normalizePair } = require("./lib/keyword_monthly_incremental_normalize.cjs");
  const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
  const { sourceForKeywordMonthlyRequest } = require("./lib/keyword_monthly_analysis.cjs");
  const { snapshotCore } = require("./reconstruct_keyword_monthly_source_copy.cjs");
  const f = await fixture(t, false), directory = path.join(f.directory, "integration-private-history"); await fs.mkdir(directory);
  const keyword = "합성키워드", at = "2026-12-31T00:00:00.000Z", observedAt = "2026-11-17T00:00:00.000Z";
  const runs = [{ id: "synthetic-target-run", keyword, collectedAt: observedAt, collectionQuality: { status: "complete" } },
    { id: "synthetic-other-run", keyword: "별도합성키워드", collectedAt: observedAt, collectionQuality: { status: "complete" } }];
  const rawCompanies = Object.fromEntries(["a", "b", "c", "d", "x", "y"].map((id, i) => {
    const selected = i < 4, runId = selected ? runs[0].id : runs[1].id;
    return [id, { companyId: id, primaryName: "합성 " + id, keywords: { selected: { keyword: selected ? keyword : runs[1].keyword,
      runs: [{ runId, rank: i + 1, collectedAt: observedAt }] } } }];
  }));
  const lines = [];
  for (const month of ["2026-11", "2026-12"]) for (const [i, id] of ["a", "b", "c", "d", "x", "y"].entries()) {
    const zero = id === "b", partial = id === "d", publicBookings = zero ? 0 : 1 + i, phoneBookings = zero ? 0 : 1;
    lines.push(JSON.stringify({ companyKey: id, companyId: id, companyName: "합성 " + id,
      runId: i < 4 ? runs[0].id : runs[1].id, keyword: i < 4 ? keyword : runs[1].keyword, collectedAt: observedAt,
      stayDate: month + "-20", productType: zero ? "dayuse" : "lodging", inventoryEvidenceVersion: 4,
      supply: 10, sold: partial ? null : publicBookings + phoneBookings, publicBookings, phoneBookings: partial ? null : phoneBookings,
      publicRevenue: publicBookings * 100, phoneRevenue: partial ? null : phoneBookings * 100,
      estimatedRevenue: partial ? null : (publicBookings + phoneBookings) * 100,
      phonePricedBookings: partial ? 0 : phoneBookings, phoneMissingPriceBookings: 0, phoneFallbackRevenue: 0, phoneFallbackBookings: 0,
      explicitBlockedBookings: 0, explicitBlockedRevenue: 0, sharedDayUseExcluded: 0,
      partial, missing: false, unknownUnavailable: partial ? 2 : 0 }));
  }
  const state = await H.append(directory, H.empty(), lines), entries = Object.values(rawCompanies).map((compact, orderIndex) => ({ companyId: compact.companyId, compact, orderIndex }));
  async function execute(implementation) {
    const reader = implementation.createReader({ directory, state }), queries = [], requests = [];
    const wrappedIndex = { ...reader, readRows: (q, c) => { queries.push(structuredClone(q)); return reader.readRows(q, c); } };
    const catalog = await createIncrementalCatalog({ entries, runs, regions: [], revision: "synthetic-pinned-revision",
      readRawCompany: async id => structuredClone(rawCompanies[id]), capacityForCompany: () => 10 });
    const service = createMonthlyReportSources({ dataDir: f.directory, regionMasterFile: path.join(f.directory, "unused-regions.json"),
      listRuns: async () => runs, observationIndex: wrappedIndex, preparedCatalogProvider: catalog,
      useSourceReadValidationBoundary: true, readRevision: async () => "synthetic-pinned-revision" });
    const wiring = { sources: { loadSources: (request, options) => { requests.push(structuredClone(request)); return service.loadSources(request, options); } } };
    const normalized = await normalizePair({ wiring, keyword, month: "2026-12", cutoffDate: "2026-12-31", capturedAt: at, retainBytes: false });
    assert.deepEqual(requests.map(r => [r.type, r.targetId, r.month]), [["keyword", keyword, "2026-11"], ["keyword", keyword, "2026-12"]]);
    assert.deepEqual(queries, [{ month: "2026-11" }, { month: "2026-12" }]); assert(queries.every(q => q.refs === undefined));
    const snapshots = ["2026-11", "2026-12"].map(month => {
      const request = { type: "keyword", targetId: keyword, month, cutoffDate: month === "2026-11" ? "2026-11-30" : "2026-12-31" };
      return buildMonthlyReportSnapshot(request, sourceForKeywordMonthlyRequest(normalized.source, request), at);
    });
    assert(snapshots.every(s => s.summary.lodging.supply > 0 && s.summary.lodging.estimatedRevenue > 0));
    assert(snapshots.every(s => s.summary.dayuse.sold === 0 && s.summary.dayuse.estimatedRevenue === 0));
    return { normalized, snapshots, cores: snapshots.map(snapshotCore), stats: reader.stats() };
  }
  const before = await inspectFiles(directory), old = await instrument(directory, () => execute(OLD), async ({ read }) => { const b = await read(); await pause(2); return b; });
  const fresh = await instrument(directory, () => execute(H), async ({ index, read }) => { const b = await read(); await pause(index % 2 ? 2 : 5); return b; });
  assert.equal(old.info.maximum, 1); assert.equal(fresh.info.maximum, 2); assert.equal(fresh.info.active, 0);
  assert.deepEqual(structuredClone(fresh.value), structuredClone(old.value)); assert.equal(hash(JSON.stringify(fresh.value.cores)), hash(JSON.stringify(old.value.cores)));
  assert.deepEqual(await inspectFiles(directory), before);
  t.diagnostic("Actual normalizePair + incremental catalog + monthly_report_sources, 2 refs-free months, all normalized and snapshot/core fields exact; synthetic I/O max 1→2.");
});
