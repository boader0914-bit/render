"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { createCompanyDetailStore, readScopedCompanyMaster, readScopedCompanyHistory, readBoundedDetailCache } = require("./lib/company_detail_store.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function cacheFixture(t, body = '{"synthetic":"한글😀","value":0}') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "detail-cache-fd-")), file = path.join(directory, "derived.json");
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + "detail-cache-fd-")); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(file, body); return { file, body: Buffer.from(body) };
}

test("derived cache reads through one bounded read-only FD, accepts partial reads and closes before returning", async t => {
  const f = await cacheFixture(t); let opens = 0, closes = 0, requested = 0;
  const fileSystem = { ...fs, readFile: () => { throw new Error("unbounded cache read forbidden"); }, open: async (file, flags) => {
    opens++; const h = await fs.open(file, flags); return { stat: (...args) => h.stat(...args), read: async (buffer, offset, length, position) => {
      requested = Math.max(requested, buffer.length); return h.read(buffer, offset, Math.min(length, 3), position);
    }, close: async () => { closes++; await h.close(); } };
  } };
  assert.deepEqual(await readBoundedDetailCache(f.file, { maxBytes: f.body.length, fileSystem }), JSON.parse(f.body));
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(requested, f.body.length + 1); assert.deepEqual(await fs.readFile(f.file), f.body);
});

test("oversized or non-regular cache is rejected before open or full string decode", async t => {
  const f = await cacheFixture(t); let opens = 0;
  await assert.rejects(() => readBoundedDetailCache(f.file, { maxBytes: 1, fileSystem: { ...fs, open: async () => { opens++; throw Error("must not open"); } } }), { code: "COMPANY_DETAIL_CACHE_INVALID" });
  assert.equal(opens, 0); assert.deepEqual(await fs.readFile(f.file), f.body);
  const initial = await fs.lstat(f.file, { bigint: true });
  await assert.rejects(() => readBoundedDetailCache(f.file, { maxBytes: 100, fileSystem: { ...fs, lstat: async () => ({ ...initial, isFile: () => true, isSymbolicLink: () => true }), open: async () => { opens++; } } }), { code: "COMPANY_DETAIL_CACHE_INVALID" }); assert.equal(opens, 0);
});

test("cache growth after stat reads at most the original size plus one and closes without parsing it", async t => {
  const f = await cacheFixture(t, '{"value":"initial"}'); let changed = false, closes = 0, bytes = 0, allocation = 0;
  const fileSystem = { ...fs, open: async (file, flags) => { const h = await fs.open(file, flags); return {
    stat: (...args) => h.stat(...args), read: async (buffer, offset, length, position) => {
      if (!changed) { changed = true; await fs.appendFile(file, "x".repeat(10000)); }
      allocation = buffer.length; const value = await h.read(buffer, offset, length, position); bytes += value.bytesRead; return value;
    }, close: async () => { closes++; await h.close(); }
  }; } };
  await assert.rejects(() => readBoundedDetailCache(f.file, { maxBytes: 128, fileSystem }), { code: "COMPANY_DETAIL_CACHE_INVALID" });
  assert.equal(closes, 1); assert.equal(bytes <= f.body.length + 1, true); assert.equal(allocation, f.body.length + 1);
});

test("same-size cache mutation and premature EOF are rejected and their FDs are closed", async t => {
  for (const mode of ["mutate", "eof"]) {
    const f = await cacheFixture(t, '{"value":"initial"}'); let first = true, closes = 0;
    const fileSystem = { ...fs, open: async (file, flags) => { const h = await fs.open(file, flags); return {
      stat: (...args) => h.stat(...args), read: async (buffer, offset, length, position) => {
        if (mode === "eof") return { bytesRead: 0, buffer };
        const value = await h.read(buffer, offset, length, position);
        if (first) { first = false; await fs.writeFile(file, '{"value":"changed"}'); }
        return value;
      }, close: async () => { closes++; await h.close(); }
    }; } };
    await assert.rejects(() => readBoundedDetailCache(f.file, { maxBytes: 128, fileSystem }), { code: "COMPANY_DETAIL_CACHE_INVALID" }); assert.equal(closes, 1);
  }
});

test("unconfirmed cache FD close is explicit and cannot silently continue to source reconstruction", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one"); let builds = 0, closes = 0;
  const store = createCompanyDetailStore({ ...f.options, build: async () => { builds++; throw Error("must not build"); }, fileSystem: { ...fs, open: async (file, flags) => {
    const h = await fs.open(file, flags); return { stat: (...args) => h.stat(...args), read: (...args) => h.read(...args), close: async () => { closes++; await h.close(); throw Object.assign(Error("unconfirmed close"), { code: "EIO" }); } };
  } } });
  await assert.rejects(() => store.get("one"), { code: "COMPANY_DETAIL_CACHE_CLOSE_FAILED" }); assert.equal(closes, 1); assert.equal(builds, 0);
});

test("an oversized existing disk cache rebuilds from unchanged source without an unbounded cache read", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one"); const directory = path.join(f.dataDir, "company_master/detail_read_models"), [name] = await fs.readdir(directory), file = path.join(directory, name);
  const originals = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]); await fs.writeFile(file, "x".repeat(20000)); let opens = 0;
  const store = createCompanyDetailStore({ ...f.options, maxEntryBytes: 4096, fileSystem: { ...fs, open: async (...args) => { opens++; return fs.open(...args); }, readFile: () => { throw Error("unbounded cache read forbidden"); } } });
  const result = await store.get("one"); assert.equal(result.cacheStatus, "calculated"); assert.equal(result.data.company.companyId, "one"); assert.equal(opens, 0); assert.equal((await fs.stat(file)).size < 4096, true);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), originals);
});

test("partial cache read followed by a failed rebuild preserves the last normal disk file", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one"); const directory = path.join(f.dataDir, "company_master/detail_read_models"), [name] = await fs.readdir(directory), file = path.join(directory, name), normal = await fs.readFile(file);
  const boom = new Error("rebuild unavailable"); let closes = 0;
  const store = createCompanyDetailStore({ ...f.options, build: async () => { throw boom; }, fileSystem: { ...fs, open: async (file, flags) => {
    const h = await fs.open(file, flags); return { stat: (...args) => h.stat(...args), read: async buffer => ({ bytesRead: 0, buffer }), close: async () => { closes++; await h.close(); } };
  } } });
  await assert.rejects(() => store.get("one"), error => error === boom); assert.equal(closes, 1); assert.deepEqual(await fs.readFile(file), normal); assert.deepEqual(await fs.readdir(directory), [name]);
});

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-detail-store-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const masterFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl");
  const run = path.join(dataDir, "outputs/fixture_glamping_20261001_090000");
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true }); await fs.mkdir(run, { recursive: true });
  const company = { companyId: "one", primaryName: "글램핑", runIds: [path.basename(run)], inventory: { products: [{ name: '객실 { " }, \\ 의 문자열' }] }, keywords: { test: { runs: [{ runId: "run", rank: 1 }] } } };
  const other = { companyId: "two", primaryName: "동명 업체", inventory: { big: "irrelevant evidence" }, keywords: { test: { runs: [{ runId: "run", rank: 3 }] } } };
  await fs.writeFile(masterFile, JSON.stringify({ schemaVersion: 1, companies: { one: company, two: other }, sourceIndex: { "place:one": "one" } }));
  await fs.writeFile(historyFile, JSON.stringify({ observationId: "a", companyKey: "one", sold: 0 }) + "\n" + JSON.stringify({ observationId: "b", companyKey: "two", sold: 2 }) + "\n");
  await fs.writeFile(path.join(run, "manifest.json"), JSON.stringify({ complete: true }));
  const calls = { master: 0, history: 0, build: 0 };
  let day = "2026-10-19";
  const options = { dataDir, projectionVersion: "test-v1", dayKey: () => day,
    masterReader: async (...args) => { calls.master++; return readScopedCompanyMaster(...args); },
    historyReader: async (...args) => { calls.history++; return readScopedCompanyHistory(...args); },
    matchesObservation: (row, company) => row.companyKey === company.companyId,
    runIdsForCompany: company => company.runIds,
    build: async (id, sources) => { calls.build++; return { company: sources.master.companies[id], observations: sources.observations,
      daily: [{ sold: sources.observations[0]?.sold ?? null }], rankPeers: Object.values(sources.master.companies).map(row => row.keywords) }; } };
  return { dataDir, masterFile, historyFile, run, company, other, calls, options, nextDay: () => { day = "2026-10-20"; } };
}

test("streaming master keeps the selected record and exact rank peers across arbitrary string/chunk boundaries", async t => {
  const f = await fixture(t), original = await fs.readFile(f.masterFile, "utf8");
  for (const size of [1, 2, 7, 64, 4096]) {
    const master = await readScopedCompanyMaster(f.masterFile, "one", { stream: () => Readable.from(Array.from({ length: Math.ceil(original.length / size) }, (_, index) => original.slice(index * size, (index + 1) * size))) });
    assert.deepEqual(master.companies.one, f.company);
    assert.deepEqual(master.companies.two, { keywords: f.other.keywords });
    assert.equal(master.companies.two.inventory, undefined);
  }
  const empty = await readScopedCompanyMaster(f.masterFile, "absent");
  assert.equal(empty.companies.absent, undefined);
  assert.deepEqual(await fs.readFile(f.masterFile, "utf8"), original);
});

test("truncated/invalid source is never a successful empty company list", async t => {
  const f = await fixture(t);
  for (const value of ['{"companies":{"one":', '{"companies":null}', '{"companies":[]}', '{"companies":{"one":{}}', '{"companies":{"one":{}}}garbage',
    '{"companies" {"one":{}}}', '{"companies":{"one":{} "two":{}}}', '{"companies":{"one":{},}}',
    '{"companies":{"one":{}},"extra":truth}', '{"companies":{"one":{}},"extra":[1,]}',
    '{"companies":{"one":{}},"extra":{"nested":[1,2}}}', '{"companies":{"one":{}},"extra":"bad\\escape"}',
    '{"companies":{"one":{"companyId":"one"},"one":null}}', '{"companies":{"one":{"companyId":"one"}},"companies":null}',
    '{"companies":{"one":null}}', '{"companies":{"one":"text"}}', '{"companies":{"one":7}}',
    '{"companies":null,"companies":{"one":{}}}', '{"companies":{"one":{},"one":{}}}',
    '{\u00a0"companies":{"one":{}}}', '{"companies":{"one":{}}}\u2028']) {
    await fs.writeFile(f.masterFile, value);
    await assert.rejects(() => readScopedCompanyMaster(f.masterFile, "one"), { code: "COMPANY_DETAIL_MASTER_INVALID" });
  }
});

test("scoped history preserves real zero and global last-observation-id wins without retaining another company", async t => {
  const f = await fixture(t);
  const rows = [
    { observationId: "a", companyKey: "one", sold: 9 }, { observationId: "a", companyKey: "one", sold: 0 },
    { observationId: "reassigned", companyKey: "one", sold: 5 }, { observationId: "reassigned", companyKey: "two", sold: 6 },
    { observationId: "unknown", companyKey: "one", sold: null, missing: true }
  ];
  await fs.writeFile(f.historyFile, rows.map(row => JSON.stringify(row)).join("\r\n") + '\n{"partial');
  const got = await readScopedCompanyHistory(f.historyFile, f.company, f.options.matchesObservation);
  assert.deepEqual(got, [rows[1], rows[4]]);
});

test("saved detail survives restart without source-body reads, one in-flight build is shared, originals remain untouched", async t => {
  const f = await fixture(t), inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const store = createCompanyDetailStore(f.options);
  const [first, joined] = await Promise.all([store.get("one"), store.get("one")]);
  assert.equal(first.cacheStatus, "calculated"); assert.deepEqual(first, joined);
  assert.deepEqual(f.calls, { master: 1, history: 1, build: 1 });
  assert.equal(first.data.daily[0].sold, 0);
  const memory = await store.get("one"); assert.equal(memory.cacheStatus, "memory");
  const restart = createCompanyDetailStore({ ...f.options,
    masterReader: async () => { throw new Error("raw master must not be read on restart cache hit"); },
    historyReader: async () => { throw new Error("raw history must not be read on restart cache hit"); },
    build: async () => { throw new Error("detail must not be rebuilt on restart cache hit"); } });
  const saved = await restart.get("one"); assert.equal(saved.cacheStatus, "saved"); assert.deepEqual(saved.data, first.data);
  assert.equal(saved.preparedAt, first.preparedAt);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});

test("cache checksum/write/LRU share one bounded graph encoding and preserve the saved checksum format", async t => {
  const f = await fixture(t); let encodes = 0, encodedWrite = false;
  const original = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const store = createCompanyDetailStore({ ...f.options,
    build: async (...args) => {
      const data = await f.options.build(...args);
      Object.defineProperty(data, "toJSON", { value() { encodes++; return { ...this }; } });
      return data;
    },
    fileSystem: { ...fs, writeFile: async (file, body, options) => {
      if (file.includes("detail_read_models")) encodedWrite = Array.isArray(body) && body.length === 2 && body.every(Buffer.isBuffer);
      return fs.writeFile(file, body, options);
    } }
  });
  const first = await store.get("one"); assert.equal(first.cacheStatus, "calculated");
  assert.equal(encodes, 1, "checksum and saved entry must not stringify data again"); assert.equal(encodedWrite, true);
  const directory = path.join(f.dataDir, "company_master/detail_read_models"), [name] = await fs.readdir(directory);
  const saved = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const expected = require("node:crypto").createHash("sha256").update(JSON.stringify({ ...saved, checksum: undefined })).digest("hex");
  assert.equal(saved.checksum, expected); assert.equal(saved.data.company.companyId, "one");
  const reopened = await createCompanyDetailStore(f.options).get("one"); assert.equal(reopened.cacheStatus, "saved");
  assert.deepEqual(reopened.data, saved.data); assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), original);
});

test("an oversized derived cache encode is explicit and leaves the last normal cache and originals intact", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one");
  const directory = path.join(f.dataDir, "company_master/detail_read_models"), [name] = await fs.readdir(directory), file = path.join(directory, name);
  const previous = await fs.readFile(file), original = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const capped = createCompanyDetailStore({ ...f.options, maxEntryBytes: 256,
    build: async (...args) => ({ ...await f.options.build(...args), large: "x".repeat(10000) }) });
  await assert.rejects(() => capped.get("one"), { code: "COMPANY_RESPONSE_TOO_LARGE", statusCode: 503 });
  assert.deepEqual(await fs.readFile(file), previous); assert.deepEqual(await fs.readdir(directory), [name]);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), original);
  assert.equal((await createCompanyDetailStore(f.options).get("one")).cacheStatus, "saved");
});

test("a failed iterable cache write removes its partial temporary and keeps the previous normal entry", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one");
  const directory = path.join(f.dataDir, "company_master/detail_read_models"), [name] = await fs.readdir(directory), previous = await fs.readFile(path.join(directory, name));
  let chunksSeen = 0;
  const failed = createCompanyDetailStore({ ...f.options, projectionVersion: "iterable-failure", fileSystem: { ...fs, writeFile: async (file, chunks, options) => {
    assert.equal(typeof chunks[Symbol.iterator], "function"); const iterator = chunks[Symbol.iterator](), first = iterator.next(); chunksSeen++;
    assert.equal(Buffer.isBuffer(first.value), true); await fs.writeFile(file, first.value, options);
    throw Object.assign(new Error("second chunk failed"), { code: "EIO" });
  } } });
  await assert.rejects(() => failed.get("one"), { code: "COMPANY_DETAIL_CACHE_WRITE_FAILED" }); assert.equal(chunksSeen, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, name)), previous); assert.deepEqual(await fs.readdir(directory), [name]);
});

test("actual correction, history, raw product response and KST-day changes invalidate detail rather than certifying old values", async t => {
  const f = await fixture(t), store = createCompanyDetailStore(f.options);
  await store.get("one");
  const master = JSON.parse(await fs.readFile(f.masterFile, "utf8")); master.companies.one.manualCorrection = { lodgingBasisTotal: 16 };
  await fs.writeFile(f.masterFile, JSON.stringify(master));
  const correction = await store.get("one"); assert.equal(correction.cacheStatus, "calculated"); assert.equal(correction.data.company.manualCorrection.lodgingBasisTotal, 16);
  await fs.appendFile(f.historyFile, JSON.stringify({ observationId: "a", companyKey: "one", sold: 3 }) + "\n");
  const history = await store.get("one"); assert.equal(history.cacheStatus, "calculated"); assert.equal(history.data.daily[0].sold, 3);
  await fs.writeFile(path.join(f.run, "products.json"), JSON.stringify([{ price: 200000 }]));
  assert.equal((await store.get("one")).cacheStatus, "calculated");
  f.nextDay(); assert.equal((await store.get("one")).cacheStatus, "calculated");
  assert.equal(f.calls.build, 5);
});

test("source races never overwrite last normal detail, missing history is an error rather than zero", async t => {
  const f = await fixture(t), store = createCompanyDetailStore(f.options);
  await store.get("one");
  const directory = path.join(f.dataDir, "company_master/detail_read_models");
  const cache = path.join(directory, (await fs.readdir(directory))[0]), saved = await fs.readFile(cache);
  await fs.appendFile(f.historyFile, JSON.stringify({ observationId: "b", companyKey: "one", sold: 1 }) + "\n");
  let sequence = 0;
  const racing = createCompanyDetailStore({ ...f.options, build: async (...args) => {
    const result = await f.options.build(...args); await fs.appendFile(f.historyFile, JSON.stringify({ observationId: "race" + ++sequence, companyKey: "one" }) + "\n"); return result;
  } });
  await assert.rejects(() => racing.get("one"), { code: "COMPANY_DETAIL_SOURCE_CHANGED" });
  assert.deepEqual(await fs.readFile(cache), saved);
  await fs.unlink(f.historyFile);
  await assert.rejects(() => store.get("one"), { code: "COMPANY_DETAIL_SOURCE_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(cache), saved);
});

test("corrupt derived caches rebuild from source; a missing company returns null without modifying the source", async t => {
  const f = await fixture(t), store = createCompanyDetailStore(f.options);
  await store.get("one");
  const directory = path.join(f.dataDir, "company_master/detail_read_models"), cache = path.join(directory, (await fs.readdir(directory))[0]);
  const value = JSON.parse(await fs.readFile(cache, "utf8")); value.data.daily[0].sold = 999;
  await fs.writeFile(cache, JSON.stringify(value));
  const next = await createCompanyDetailStore(f.options).get("one"); assert.equal(next.cacheStatus, "calculated"); assert.equal(next.data.daily[0].sold, 0);
  const master = await fs.readFile(f.masterFile);
  assert.equal((await store.get("unknown")).data, null);
  assert.deepEqual(await fs.readFile(f.masterFile), master);
});

test("a source change during cached run inspection cannot certify an older cached response", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one");
  let fired = false;
  const fileSystem = Object.create(fs);
  fileSystem.readdir = async (...args) => {
    if (!fired && String(args[0]).startsWith(path.join(f.dataDir, "outputs"))) {
      fired = true; const master = JSON.parse(await fs.readFile(f.masterFile, "utf8")); master.companies.one.primaryName = "실제로 변경된 업체";
      await fs.writeFile(f.masterFile, JSON.stringify(master));
    }
    return fs.readdir(...args);
  };
  await assert.rejects(() => createCompanyDetailStore({ ...f.options, fileSystem }).get("one"), { code: "COMPANY_DETAIL_SOURCE_CHANGED" });
  assert.equal(fired, true);
  assert.equal((await createCompanyDetailStore(f.options).get("one")).data.company.primaryName, "실제로 변경된 업체");
});

test("failed cache writes are explicit and preserve the previous normal saved detail", async t => {
  const f = await fixture(t); await createCompanyDetailStore(f.options).get("one");
  const directory = path.join(f.dataDir, "company_master/detail_read_models"), cache = path.join(directory, (await fs.readdir(directory))[0]), original = await fs.readFile(cache);
  await fs.appendFile(f.historyFile, JSON.stringify({ observationId: "new", companyKey: "one", sold: 1 }) + "\n");
  const fileSystem = Object.create(fs);
  fileSystem.writeFile = async () => { throw Object.assign(new Error("Disk unavailable"), { code: "ENOSPC" }); };
  await assert.rejects(() => createCompanyDetailStore({ ...f.options, fileSystem }).get("one"), { code: "COMPANY_DETAIL_CACHE_WRITE_FAILED" });
  assert.deepEqual(await fs.readFile(cache), original);
});

test("large detail remains available from saved storage without exceeding the memory byte budget", async t => {
  const f = await fixture(t), store = createCompanyDetailStore({ ...f.options, maxMemoryBytes: 1 });
  assert.equal((await store.get("one")).cacheStatus, "calculated");
  assert.equal((await store.get("one")).cacheStatus, "saved", "oversized entries are not retained in the memory LRU");
  assert.deepEqual(f.calls, { master: 1, history: 1, build: 1 });
});

test("run references cannot escape the outputs directory even through dot path components", async t => {
  const f = await fixture(t);
  for (const id of [".", "..", "../config", "..\\config", "/absolute", "name/child"]) {
    const store = createCompanyDetailStore({ ...f.options, projectionVersion: "unsafe-" + id, runIdsForCompany: () => [id] });
    await assert.rejects(() => store.get("one"), { code: "COMPANY_DETAIL_SOURCE_UNAVAILABLE" });
  }
});

test("queued detail and nested same-ID readers coalesce after admission without self-deadlock", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate();
  let admissions = 0;
  const store = createCompanyDetailStore({ ...f.options,
    runWork: (operation, options) => { admissions++; return scheduler.run(operation, options); } });
  assert.equal(admissions, 0);
  const owner = scheduler.run(async () => { entered.resolve(); await nested.promise; return Promise.all([store.get("one"), store.get("one")]); });
  await entered.promise; const queued = store.get(" one ");
  assert.equal(f.calls.master, 0); assert.equal(scheduler.status().queuedForeground, 1); nested.resolve();
  const values = await owner; assert.equal(values[0], values[1]); assert.equal(await queued, values[0]);
  assert.deepEqual(f.calls, { master: 1, history: 1, build: 1 }); await scheduler.close();
});

test("different detail IDs and warm revision checks remain inside shared admission", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), firstRead = gate(), releaseRead = gate();
  let activeReads = 0, peakReads = 0, first = true;
  const store = createCompanyDetailStore({ ...f.options,
    runWork: (operation, options) => scheduler.run(operation, options), runIdsForCompany: company => company.runIds || [],
    masterReader: async (...args) => {
      peakReads = Math.max(peakReads, ++activeReads);
      if (first) { first = false; firstRead.resolve(); await releaseRead.promise; }
      try { return await f.options.masterReader(...args); } finally { activeReads--; }
    } });
  const one = store.get("one"); await firstRead.promise; const two = store.get("two");
  assert.equal(scheduler.status().queuedForeground, 1); releaseRead.resolve();
  const values = await Promise.all([one, two]); assert.equal(values[0].data.company.companyId, "one");
  assert.equal(values[1].data.company.companyId, "two"); assert.equal(peakReads, 1);
  const entered = gate(), release = gate();
  const owner = scheduler.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  let warmDone = false; const warm = store.get("one").then(value => { warmDone = true; return value; });
  assert.equal(scheduler.status().queuedForeground, 1); assert.equal(warmDone, false); release.resolve(); await owner;
  assert.equal((await warm).cacheStatus, "memory"); assert.equal(f.calls.master, 2); await scheduler.close();
});
