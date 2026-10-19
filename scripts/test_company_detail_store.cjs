"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { createCompanyDetailStore, readScopedCompanyMaster, readScopedCompanyHistory } = require("./lib/company_detail_store.cjs");

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
