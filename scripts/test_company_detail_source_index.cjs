"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const native = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { createCompanyDetailSourceIndex, defaultHistoryIdentity } = require("./lib/company_detail_source_index.cjs");
const { readScopedCompanyMaster, readScopedCompanyHistory } = require("./lib/company_detail_store.cjs");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const matches = (row, company) => [company.companyId, ...(company.aliases || []), ...(company.duplicateNotes || []).map(value => value.mergedCompanyId)]
  .some(key => key === row.companyKey || key === row.companyName);

async function fixture(t, { history = null, master = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-detail-source-index-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
  const company = { companyId: "one", primaryName: '모의 글램핑 { "문자열" }', aliases: ["별칭", "이름 연결"], duplicateNotes: [{ mergedCompanyId: "old-one" }],
    capacity: 16, products: [{ name: "숙박", stock: 0, price: null }], keywords: { "경남글램핑": { runs: [{ runId: "run-a", rank: 1 }] } } };
  const other = { companyId: "two", primaryName: "다른 업체", largeRawEvidence: "무관측 자료".repeat(20000), keywords: { "경남글램핑": { runs: [{ runId: "run-a", rank: 3 }] } } };
  const rows = history || [
    { observationId: "kept", companyKey: "one", sold: 4, raw: "이전 수량" },
    { observationId: "kept", companyKey: "one", sold: 0, publicRevenue: 0, raw: "정상 0실" },
    { observationId: "removed", companyKey: "one", sold: 5 },
    { observationId: "removed", companyKey: "two", sold: 6 },
    { observationId: "alias", companyKey: "별칭", sold: null, missing: true },
    { observationId: "merged", companyKey: "old-one", sold: 1 },
    { observationId: "name", companyName: "이름 연결", sold: 2 },
    { observationId: "unrelated", companyKey: "two", sold: 9, raw: "대량 다른 업체 자료".repeat(20000) }
  ];
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(masterFile, "\uFEFF" + JSON.stringify(master || { companies: { one: company, two: other } }));
  await fs.writeFile(historyFile, rows.map(row => JSON.stringify(row)).join("\r\n"));
  const calls = { master: 0, history: 0 }, options = { dataDir,
    masterReader: async (...args) => { calls.master++; return readScopedCompanyMaster(...args); },
    createReadStream: file => { calls.history++; return native.createReadStream(file, { highWaterMark: 64 * 1024 }); } };
  const directory = path.join(dataDir, "company_master", "detail_source_index");
  return { dataDir, masterFile, historyFile, company, other, rows, options, calls, directory,
    pointer: path.join(directory, "current.json"), readPointer: async () => JSON.parse(await fs.readFile(path.join(directory, "current.json"), "utf8")) };
}

test("one preparation writes exact company shards and keywords-only peers without changing source bytes", async t => {
  const f = await fixture(t), before = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const index = createCompanyDetailSourceIndex(f.options), ready = await index.prepare();
  assert.equal(ready.ready, true); assert.equal(ready.cacheStatus, "built"); assert.equal(ready.companyCount, 2);
  const master = await index.readMaster(f.masterFile, "one");
  assert.deepEqual(master.companies.one, f.company);
  assert.deepEqual(master.companies.two, { keywords: f.other.keywords });
  assert.equal(master.companies.two.largeRawEvidence, undefined);
  assert.deepEqual(await index.readHistory(f.historyFile, f.company, matches), await readScopedCompanyHistory(f.historyFile, f.company, matches));
  assert.equal(f.calls.master, 1); assert.equal(f.calls.history, 1);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), before);
});

test("UTF8 offsets, CRLF, no final newline, partial lines, true zero and missing remain identical to the scoped reader", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.historyFile, f.rows.slice(0, -1).map(row => JSON.stringify(row)).join("\r\n"));
  f.options.createReadStream = file => native.createReadStream(file, { highWaterMark: 7 });
  await fs.appendFile(f.historyFile, '\n{"partial\n' + JSON.stringify({ observationId: "last", companyName: "이름 연결", raw: "끝🌿한글", sold: 0 }));
  const index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const result = await index.readHistory(f.historyFile, f.company, matches);
  assert.deepEqual(result, await readScopedCompanyHistory(f.historyFile, f.company, matches));
  assert.equal(result.find(row => row.observationId === "kept").sold, 0);
  assert.equal(result.find(row => row.observationId === "alias").sold, null);
  assert.equal(result.find(row => row.observationId === "alias").missing, true);
  assert.equal(result.at(-1).raw, "끝🌿한글");
});

test("identity transitions preserve A(id1),A(id2),B(id1),A(id1) order and later reassignment removes earlier data", async t => {
  const rows = [
    { observationId: "id1", companyKey: "one", sold: 1 }, { observationId: "id2", companyKey: "one", sold: 2 },
    { observationId: "id1", companyKey: "two", sold: 3 }, { observationId: "id1", companyKey: "one", sold: 4 },
    { observationId: "id1", companyKey: "one", sold: 0 }, { observationId: "id3", companyKey: "one", sold: 6 },
    { observationId: "id3", companyKey: "two", sold: 7 }
  ];
  const f = await fixture(t, { history: rows }), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  assert.deepEqual(await index.readHistory(f.historyFile, f.company, matches), [rows[1], rows[4]]);
  assert.deepEqual(await index.readHistory(f.historyFile, f.other, matches), await readScopedCompanyHistory(f.historyFile, f.other, matches));
  assert.equal(index.status().historyRowCount, 3);
  assert.equal(index.status().historyEventCount, 6, "only equal-identity consecutive updates for one id are compacted");
});

test("one in-flight preparation is shared, and saved restart opens no whole master/history source stream", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options);
  const first = index.prepare(), joined = index.prepare(); assert.equal(first, joined);
  await first; assert.deepEqual(f.calls, { master: 1, history: 1 });
  const restart = createCompanyDetailSourceIndex({ ...f.options,
    masterReader: async () => { throw new Error("no full master scan on saved index reuse"); },
    createReadStream: () => { throw new Error("no full history scan on saved index reuse"); } });
  const reused = await restart.prepare(); assert.equal(reused.cacheStatus, "reused");
  assert.deepEqual((await restart.readMaster(f.masterFile, "one")).companies.one, f.company);
  assert.deepEqual(await restart.readHistory(f.historyFile, f.company, matches), await readScopedCompanyHistory(f.historyFile, f.company, matches));
  assert.equal(reused.preparedAt, index.status().preparedAt);
});

test("a first read is explicitly preparing and source changes schedule one background rebuild before fresh reads", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options);
  await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING", statusCode: 503 });
  await index.prepare();
  const source = JSON.parse((await fs.readFile(f.masterFile, "utf8")).replace(/^\uFEFF/, "")); source.companies.one.capacity = 17;
  await fs.writeFile(f.masterFile, JSON.stringify(source));
  await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await index.prepare();
  assert.equal((await index.readMaster(f.masterFile, "one")).companies.one.capacity, 17);
  assert.deepEqual(f.calls, { master: 2, history: 2 });
});

test("unrelated run files and wall clock changes do not invalidate a ready source index", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const pointer = await fs.readFile(f.pointer);
  await fs.mkdir(path.join(f.dataDir, "outputs", "run-a"), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, "outputs", "run-a", "products.json"), JSON.stringify({ stock: 0 }));
  const ready = await index.prepare(); assert.equal(ready.cacheStatus, "reused");
  assert.deepEqual(f.calls, { master: 1, history: 1 }); assert.deepEqual(await fs.readFile(f.pointer), pointer);
});

test("empty history is valid zero rows; missing source is an error and never replaces the last normal pointer", async t => {
  const f = await fixture(t); await fs.writeFile(f.historyFile, "");
  const index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  assert.deepEqual(await index.readHistory(f.historyFile, f.company, matches), []);
  assert.equal(index.status().historyRowCount, 0);
  const saved = await fs.readFile(f.pointer); await fs.unlink(f.historyFile);
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_MISSING" });
  await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_MISSING" });
  assert.deepEqual(await fs.readFile(f.pointer), saved);
  assert.equal(index.status().ready, false);
});

test("a source change during preparation preserves the previous pointer and never publishes mixed shards", async t => {
  const f = await fixture(t), initial = createCompanyDetailSourceIndex(f.options); await initial.prepare();
  const saved = await fs.readFile(f.pointer);
  const racing = createCompanyDetailSourceIndex({ ...f.options, masterReader: async (...args) => {
    const value = await readScopedCompanyMaster(...args);
    await fs.appendFile(f.historyFile, "\n" + JSON.stringify({ observationId: "racing", companyKey: "one", sold: 9 }));
    return value;
  } });
  await assert.rejects(racing.prepare({ force: true }), { code: "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED" });
  assert.deepEqual(await fs.readFile(f.pointer), saved); assert.equal(racing.status().phase, "failed");
});

test("corrupt selected shard is not served or changed into empty data and is rebuilt in the background", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const saved = await f.readPointer(), shard = path.join(f.directory, saved.generation, saved.companies.one.file);
  await fs.writeFile(shard, JSON.stringify({ companyId: "one", capacity: 999 }));
  await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await index.prepare();
  assert.equal((await index.readMaster(f.masterFile, "one")).companies.one.capacity, 16);
  assert.notEqual((await f.readPointer()).generation, saved.generation);
});

test("a checksum-valid path traversal pointer is rejected and only a contained generation can be published", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const value = await f.readPointer(); value.generation = "../outside";
  value.checksum = digest(JSON.stringify({ ...value, checksum: undefined })); await fs.writeFile(f.pointer, JSON.stringify(value));
  const restart = createCompanyDetailSourceIndex(f.options); await restart.prepare();
  const current = await f.readPointer(); assert.match(current.generation, /^generation_[a-f0-9]{32}$/);
  assert.equal((await restart.readMaster(f.masterFile, "one")).companies.one.capacity, 16);
  await assert.rejects(restart.readMaster(path.join(f.dataDir, "other.json"), "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PATH_INVALID" });
  await assert.rejects(restart.readHistory(f.masterFile, f.company, matches), { code: "COMPANY_DETAIL_SOURCE_INDEX_PATH_INVALID" });
});

test("missing company, peer mutation and actual normal-zero data remain separate and independent", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const missing = await index.readMaster(f.masterFile, "absent"); assert.equal(Object.hasOwn(missing.companies, "absent"), false);
  const first = await index.readMaster(f.masterFile, "one"); first.companies.two.keywords["경남글램핑"].runs[0].rank = 999;
  assert.equal((await index.readMaster(f.masterFile, "one")).companies.two.keywords["경남글램핑"].runs[0].rank, 3);
  assert.deepEqual((await index.readMaster(f.masterFile, "one")).companies.one.products[0], { name: "숙박", stock: 0, price: null });
});

test("malformed master and incomplete builder contract leave the last normal index intact", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const saved = await fs.readFile(f.pointer), original = await fs.readFile(f.masterFile);
  await fs.writeFile(f.masterFile, '{"companies":{"one":');
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_MASTER_INVALID" });
  assert.deepEqual(await fs.readFile(f.pointer), saved);
  await fs.writeFile(f.masterFile, original);
  const wrong = createCompanyDetailSourceIndex({ ...f.options, masterReader: async () => ({ companies: { one: { keywords: {} } } }) });
  await assert.rejects(wrong.prepare({ force: true }), { code: "COMPANY_DETAIL_SOURCE_INDEX_BUILDER_CONTRACT" });
  assert.deepEqual(await fs.readFile(f.pointer), saved);
});

test("history identity projection can be explicitly extended without changing full selected row values", async t => {
  const f = await fixture(t), projector = row => ({ ...defaultHistoryIdentity(row), sold: row.sold });
  const index = createCompanyDetailSourceIndex({ ...f.options, projectionVersion: "sold-aware-matcher-v1", historyIdentity: projector }); await index.prepare();
  const matcher = (row, company) => matches(row, company) && row.sold === 0;
  assert.deepEqual(await index.readHistory(f.historyFile, f.company, matcher), await readScopedCompanyHistory(f.historyFile, f.company, matcher));
});

test("history BOM follows the original reader's malformed-line policy rather than inventing an observation", async t => {
  const f = await fixture(t); const bytes = await fs.readFile(f.historyFile);
  await fs.writeFile(f.historyFile, Buffer.concat([Buffer.from("\uFEFF" + JSON.stringify({ observationId: "bom-only", companyKey: "one", sold: 8 }) + "\n"), bytes]));
  const index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const actual = await index.readHistory(f.historyFile, f.company, matches);
  assert.deepEqual(actual, await readScopedCompanyHistory(f.historyFile, f.company, matches));
  assert.equal(actual.some(row => row.observationId === "bom-only"), false);
});

test("prepared lookup reads only selected raw history ranges and no complete master/history body", async t => {
  const f = await fixture(t), calls = { sourceReadFile: 0, historyBytes: 0, historyReads: 0 };
  const fileSystem = Object.create(fs);
  fileSystem.readFile = async (file, ...args) => { if ([f.masterFile, f.historyFile].includes(String(file))) calls.sourceReadFile++; return fs.readFile(file, ...args); };
  fileSystem.open = async (...args) => {
    const handle = await fs.open(...args);
    return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), read: async (...readArgs) => {
      const result = await handle.read(...readArgs); calls.historyBytes += result.bytesRead; calls.historyReads++; return result;
    } };
  };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem }); await index.prepare();
  await index.readMaster(f.masterFile, "one");
  const rows = await index.readHistory(f.historyFile, f.company, matches);
  assert.deepEqual(rows, await readScopedCompanyHistory(f.historyFile, f.company, matches));
  assert.equal(calls.sourceReadFile, 0);
  assert.equal(calls.historyReads, rows.length);
  assert.ok(calls.historyBytes < Number((await fs.stat(f.historyFile)).size) / 50, "unrelated large evidence is not downloaded or parsed for the selected company");
});

test("a positional-read source race schedules fresh preparation and never returns mixed observations", async t => {
  const f = await fixture(t); let changed = false;
  const fileSystem = Object.create(fs);
  fileSystem.open = async (...args) => {
    const handle = await fs.open(...args);
    return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), read: async (...readArgs) => {
      const result = await handle.read(...readArgs);
      if (!changed) { changed = true; await fs.appendFile(f.historyFile, "\n" + JSON.stringify({ observationId: "new-source", companyKey: "one", sold: 12 })); }
      return result;
    } };
  };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem }); await index.prepare();
  await assert.rejects(index.readHistory(f.historyFile, f.company, matches), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await index.prepare();
  assert.equal((await index.readHistory(f.historyFile, f.company, matches)).find(row => row.observationId === "new-source").sold, 12);
});

test("a corrupt history byte-offset index is rejected before raw ranges are read", async t => {
  const f = await fixture(t), initial = createCompanyDetailSourceIndex(f.options); await initial.prepare();
  const pointer = await f.readPointer(), meta = path.join(f.directory, pointer.generation, pointer.history.file);
  const value = JSON.parse(await fs.readFile(meta, "utf8")); value.events[0].offset = 999999;
  await fs.writeFile(meta, JSON.stringify(value));
  const restart = createCompanyDetailSourceIndex(f.options); await restart.prepare();
  await assert.rejects(restart.readHistory(f.historyFile, f.company, matches), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await restart.prepare();
  assert.deepEqual(await restart.readHistory(f.historyFile, f.company, matches), await readScopedCompanyHistory(f.historyFile, f.company, matches));
});

test("atomic publication failure preserves the last normal pointer and original source data", async t => {
  const f = await fixture(t), initial = createCompanyDetailSourceIndex(f.options); await initial.prepare();
  const saved = await fs.readFile(f.pointer), inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const fileSystem = Object.create(fs);
  fileSystem.writeFile = async (file, ...args) => { if (String(file).startsWith(f.pointer + ".")) throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); return fs.writeFile(file, ...args); };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem });
  await assert.rejects(index.prepare({ force: true }), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARE_FAILED" });
  assert.deepEqual(await fs.readFile(f.pointer), saved);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});

test("a shard write failure is reported as derived storage failure rather than invalid original master", async t => {
  const f = await fixture(t), initial = createCompanyDetailSourceIndex(f.options); await initial.prepare();
  const saved = await fs.readFile(f.pointer), inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const fileSystem = Object.create(fs);
  fileSystem.writeFile = async (file, ...args) => { if (String(file).includes("generation_")) throw Object.assign(new Error("full derived storage"), { code: "ENOSPC" }); return fs.writeFile(file, ...args); };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem });
  await assert.rejects(index.prepare({ force: true }), { code: "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED", statusCode: 503 });
  assert.equal(index.status().errorCode, "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED");
  assert.deepEqual(await fs.readFile(f.pointer), saved);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});

test("many interleaved identity transitions exactly match the original scoped history order", async t => {
  let seed = 1946819644;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const rows = Array.from({ length: 500 }, (_, index) => ({ observationId: "id" + random(23), companyKey: ["one", "two", "별칭", "old-one", "other"][random(5)], sold: index % 17 }));
  const f = await fixture(t, { history: rows }), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  for (const company of [f.company, f.other, { companyId: "neither", aliases: ["two", "old-one"] }]) {
    assert.deepEqual(await index.readHistory(f.historyFile, company, matches), await readScopedCompanyHistory(f.historyFile, company, matches));
  }
});

test("a linked source parent directory is rejected before any derived generation is written", async t => {
  const f = await fixture(t), actual = path.join(f.dataDir, "actual_company_master");
  await fs.rename(path.dirname(f.masterFile), actual);
  try { await fs.symlink(actual, path.dirname(f.masterFile), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("directory links unavailable on this host"); return; } throw error; }
  const index = createCompanyDetailSourceIndex(f.options);
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_SOURCE_INDEX_INVALID" });
  await assert.rejects(fs.stat(path.join(actual, "detail_source_index")), { code: "ENOENT" });
  assert.ok((await fs.readFile(path.join(actual, "companies.json"))).length > 0);
});

test("successful publication keeps only current and previous normal generations and leaves all original bytes intact", async t => {
  const f = await fixture(t), inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const index = createCompanyDetailSourceIndex(f.options), published = [];
  for (let count = 0; count < 4; count++) { await index.prepare({ force: true }); published.push((await f.readPointer()).generation); }
  const current = await f.readPointer();
  assert.equal(current.generation, published[3]); assert.equal(current.previousGeneration, published[2]);
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => /^generation_[a-f0-9]{32}$/.test(name)).sort(), published.slice(2).sort());
  assert.deepEqual((await index.readMaster(f.masterFile, "one")).companies.one, f.company);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});

test("in-flight master and history readers pin an older generation until their finally releases it", async t => {
  for (const kind of ["master", "history"]) await t.test(kind, async sub => {
    const f = await fixture(sub); let armed = false, held = false, selectedFile;
    let openGate, markReached; const gate = new Promise(resolve => { openGate = resolve; });
    const reached = new Promise(resolve => { markReached = resolve; });
    const hold = async () => { if (armed && !held) { held = true; markReached(); await gate; } };
    const fileSystem = Object.create(fs);
    fileSystem.readFile = async (file, ...args) => { if (kind === "master" && String(file) === selectedFile) await hold(); return fs.readFile(file, ...args); };
    fileSystem.open = async (...args) => {
      const handle = await fs.open(...args);
      return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), read: async (...readArgs) => {
        if (kind === "history") await hold(); return handle.read(...readArgs);
      } };
    };
    const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem }); await index.prepare();
    const first = await f.readPointer(); selectedFile = path.join(f.directory, first.generation, first.companies.one.file); armed = true;
    const reading = kind === "master" ? index.readMaster(f.masterFile, "one") : index.readHistory(f.historyFile, f.company, matches);
    await reached;
    await index.prepare({ force: true }); await index.prepare({ force: true });
    assert.equal((await fs.readdir(f.directory)).filter(name => /^generation_[a-f0-9]{32}$/.test(name)).length, 3);
    assert.equal((await fs.stat(path.join(f.directory, first.generation))).isDirectory(), true);
    openGate(); const result = await reading;
    if (kind === "master") assert.deepEqual(result.companies.one, f.company);
    else assert.deepEqual(result, await readScopedCompanyHistory(f.historyFile, f.company, matches));
    await index.prepare();
    await assert.rejects(fs.stat(path.join(f.directory, first.generation)), { code: "ENOENT" });
    assert.equal((await fs.readdir(f.directory)).filter(name => /^generation_[a-f0-9]{32}$/.test(name)).length, 2);
  });
});

test("cleanup failures cannot turn a correctly published new index into a failed preparation", async t => {
  const f = await fixture(t), fileSystem = Object.create(fs), inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  fileSystem.rm = async file => { assert.equal(path.dirname(path.resolve(file)), f.directory); throw Object.assign(new Error("derived cleanup denied"), { code: "EACCES" }); };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem });
  await index.prepare(); await index.prepare({ force: true }); const ready = await index.prepare({ force: true });
  assert.equal(ready.ready, true); assert.equal(ready.phase, "ready"); assert.equal(ready.errorCode, null);
  assert.ok(ready.cleanup.warningCount > 0);
  assert.equal((await index.readMaster(f.masterFile, "one")).companies.one.capacity, 16);
  assert.equal(index.status().ready, true);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});

test("unknown, invalid and linked generation folders are preserved with explicit cleanup warnings", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex(f.options); await index.prepare();
  const first = await f.readPointer(), bad = path.join(f.directory, first.generation, first.companies.one.file);
  await fs.writeFile(bad, "corrupt derived bytes");
  const unknownName = "generation_" + "f".repeat(32), unknown = path.join(f.directory, unknownName);
  await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, "unmanaged.txt"), "keep unknown folder");
  await fs.mkdir(path.join(f.directory, "generation_unknown"));
  const target = path.join(f.dataDir, "outside_target"), linkName = "generation_" + "e".repeat(32), linked = path.join(f.directory, linkName);
  await fs.mkdir(target); await fs.writeFile(path.join(target, "untouched.txt"), "not a cache generation");
  let hasLink = true;
  try { await fs.symlink(target, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) hasLink = false; else throw error; }
  await index.prepare({ force: true }); const ready = await index.prepare({ force: true });
  assert.equal(ready.ready, true); assert.ok(ready.cleanup.warningCount >= 3);
  assert.equal(await fs.readFile(bad, "utf8"), "corrupt derived bytes");
  assert.equal(await fs.readFile(path.join(unknown, "unmanaged.txt"), "utf8"), "keep unknown folder");
  assert.equal(await fs.readFile(path.join(target, "untouched.txt"), "utf8"), "not a cache generation");
  if (hasLink) assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
});

test("selected positional reads are bounded in concurrency and memory while output remains in exact history order", async t => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ observationId: "row" + index, companyKey: "one", sold: index }));
  const f = await fixture(t, { history: rows }), fileSystem = Object.create(fs);
  let running = 0, bytes = 0, peak = 0, peakBytes = 0;
  fileSystem.open = async (...args) => {
    const handle = await fs.open(...args);
    return { stat: handle.stat.bind(handle), close: async () => { assert.equal(running, 0); await handle.close(); }, read: async (...readArgs) => {
      running++; bytes += readArgs[0].length; peak = Math.max(peak, running); peakBytes = Math.max(peakBytes, bytes);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await handle.read(...readArgs); }
      finally { running--; bytes -= readArgs[0].length; }
    } };
  };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem, maxHistoryReadBytes: 256 }); await index.prepare();
  assert.deepEqual(await index.readHistory(f.historyFile, f.company, matches), rows);
  assert.ok(peak > 1 && peak <= 8); assert.ok(peakBytes <= 256);
});

test("positional read failure waits for in-flight readers before closing and never returns an incomplete zero", async t => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ observationId: "row" + index, companyKey: "one", sold: index }));
  const f = await fixture(t, { history: rows }), fileSystem = Object.create(fs); let running = 0, reads = 0;
  fileSystem.open = async (...args) => {
    const handle = await fs.open(...args);
    return { stat: handle.stat.bind(handle), close: async () => { assert.equal(running, 0); await handle.close(); }, read: async (...readArgs) => {
      const number = ++reads; running++;
      try { await new Promise(resolve => setTimeout(resolve, 2)); if (number === 1) throw Object.assign(new Error("read unavailable"), { code: "EIO" }); return await handle.read(...readArgs); }
      finally { running--; }
    } };
  };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem }); await index.prepare();
  await assert.rejects(index.readHistory(f.historyFile, f.company, matches), { code: "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_UNAVAILABLE" });
  assert.equal(running, 0); assert.ok(reads <= 8);
});

test("a failed unchanged source exposes its actual error without restarting preparation on every poll", async t => {
  const f = await fixture(t), fileSystem = Object.create(fs); let fail = true;
  fileSystem.writeFile = async (file, ...args) => { if (fail && String(file).includes("generation_")) throw Object.assign(new Error("full derived disk"), { code: "ENOSPC" }); return fs.writeFile(file, ...args); };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem });
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED" });
  for (let count = 0; count < 3; count++) await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED" });
  assert.equal(index.status().phase, "failed"); assert.deepEqual(f.calls, { master: 1, history: 0 });
  fail = false; await index.prepare();
  assert.equal((await index.readMaster(f.masterFile, "one")).companies.one.capacity, 16);
  assert.equal(index.status().phase, "ready");
});

test("a genuinely changed source may prepare again after a previous source failed", async t => {
  const f = await fixture(t), fileSystem = Object.create(fs); let fail = true;
  fileSystem.writeFile = async (file, ...args) => { if (fail && String(file).includes("generation_")) throw Object.assign(new Error("full derived disk"), { code: "ENOSPC" }); return fs.writeFile(file, ...args); };
  const index = createCompanyDetailSourceIndex({ ...f.options, fileSystem });
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED" });
  const master = JSON.parse((await fs.readFile(f.masterFile, "utf8")).replace(/^\uFEFF/, "")); master.companies.one.capacity = 17;
  await fs.writeFile(f.masterFile, JSON.stringify(master)); fail = false;
  await assert.rejects(index.readMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await index.prepare(); assert.equal((await index.readMaster(f.masterFile, "one")).companies.one.capacity, 17);
});
