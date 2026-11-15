"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { inspectSource, buildSourceWiring, IMPORTS, BUILD_ORDER } = require("./lib/keyword_monthly_source_wiring.cjs");
const { installGuards, publicSource, args, snapshotCore } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const codeRoot = path.resolve(__dirname, "..");
test("source inspection parses exact declarations without application or provider entry execution", () => {
  const value = inspectSource(codeRoot);
  assert.match(value.bindings.appSha256, /^[a-f0-9]{64}$/); assert.equal(value.bindings.appEntryExecutions, 0); assert.equal(value.bindings.providerFactories, 0);
  for (const forbidden of ["tourism_collector.cjs", "lib/kosis.cjs", "collector_worker.cjs", "glamping_app_server.cjs"]) assert.equal(IMPORTS.some(row => row[0] === forbidden), false);
  assert.equal(BUILD_ORDER.includes("monthlyReportService"), false); assert.equal(BUILD_ORDER.includes("kosisService"), false);
});
test("copy-only wiring builds and normalizes an empty saved fixture without importing a service entry", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-wiring-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "company_master")); await fs.mkdir(path.join(root, "history")); await fs.mkdir(path.join(root, "outputs"));
  await fs.writeFile(path.join(root, "company_master/companies.json"), '{"companies":{}}'); await fs.writeFile(path.join(root, "history/observations.jsonl"), "");
  const guard = installGuards(root, { codeRoot });
  try {
    const wiring = buildSourceWiring({ codeRoot, copyDataDir: root, now: "2026-10-30T00:00:00.000Z" });
    for (const blocked of ["./collector_worker.cjs", "./tourism_collector.cjs", "./lib/kosis.cjs", "./glamping_app_server.cjs", "node:child_process"]) assert.equal(wiring.requireAllowlist.includes(blocked), false);
    assert.equal(wiring.metrics.appEntryExecutions, 0); assert.equal(wiring.metrics.providerFactories, 0);
    const result = await wiring.sources.loadSources({ type: "keyword", targetId: "empty-fixture", month: "2026-10", cutoffDate: "2026-10-30" }, { includeContext: false, priority: "foreground" });
    assert.deepEqual(result.observations, []); assert.deepEqual(result.savedProductRecoveries, []); assert.deepEqual(result.rankObservations, []);
    assert.equal(wiring.metrics.savedRunLoads, 0); assert.equal(wiring.metrics.deniedRequires, 0);
    assert.equal(guard.metrics.networkAttempts, 0); assert.equal(guard.metrics.outsideCopyWriteAttempts, 0); wiring.assertCodeCurrent();
    wiring.index.close(); wiring.scheduler.close();
  } finally { guard.restore(); }
});

test("incremental wiring adopts a lazy pinned catalog without a master or history scan", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-wiring-incremental-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const descriptor = { generation: 0, contentDigest: "1".repeat(64), malformedHistoryLines: 0, source: null };
  const observationIndex = { ensure: async () => structuredClone(descriptor), readRows: async () => {}, readHeaders: async () => {},
    revisionPartitions: async () => ({ ...descriptor, partitions: [] }), listMonths: async () => [] };
  const incremental = { observationIndex, catalog: null, revision: "incremental-private-1", runs: [] };
  const wiring = buildSourceWiring({ codeRoot, copyDataDir: root, now: "2026-11-15T00:00:00.000Z", incremental });
  t.after(() => wiring.scheduler.close());
  assert.equal(wiring.index, observationIndex);
  assert.equal(wiring.bindings.observationIndexMode, "incremental_saved_deltas");
  for (const name of ["prepareCompanies", "projectCapacityCompany", "capacityForCompany"]) assert.equal(typeof wiring.bridge[name], "function");
  const request = { type: "keyword", targetId: "empty-private-fixture", month: "2026-11", cutoffDate: "2026-11-15" };
  await assert.rejects(wiring.sources.loadSources(request, { includeContext: false }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  const { createIncrementalCatalog } = require("./lib/keyword_monthly_incremental_catalog.cjs");
  incremental.catalog = await createIncrementalCatalog({ entries: [], runs: [], regions: [], revision: incremental.revision,
    readRawCompany: async () => { throw new Error("no raw fixture"); }, capacityForCompany: wiring.bridge.capacityForCompany,
    projectCapacityCompany: wiring.bridge.projectCapacityCompany });
  const source = await wiring.sources.loadSources(request, { includeContext: false });
  assert.deepEqual(source.observations, []);
  assert.equal(wiring.sources.sourceReadMetrics().catalogFullReads, 0);
  assert.equal(wiring.metrics.savedRunLoads, 0);
  assert.deepEqual(await wiring.listRuns(), []);
  await assert.rejects(fs.access(path.join(root, "outputs")), { code: "ENOENT" });
  incremental.revision = "incremental-private-2";
  assert.equal(await wiring.sources.readRevision(), "incremental-private-2");
  incremental.runs = [{ id: "old", collectedAt: "2026-10-01T00:00:00Z" }, { id: "new", collectedAt: "2026-11-01T00:00:00Z" }];
  assert.deepEqual((await wiring.listRuns()).map(run => run.id), ["new", "old"]);
  const prepared = await wiring.bridge.prepareCompanies({}, { runs: [] });
  assert.deepEqual(Object.keys(prepared), []);
  await assert.rejects(fs.access(path.join(root, "company_master/companies.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, "history/observations.jsonl")), { code: "ENOENT" });
});

test("incremental wiring preserves catalog rejection instead of falling back to original inputs", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-wiring-incremental-failed-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  let originalReads = 0;
  const observationIndex = { ensure: async () => { originalReads++; throw new Error("must not read"); }, readRows: async () => {}, revisionPartitions: async () => ({ partitions: [] }) };
  const reject = () => { throw Object.assign(new Error("fixture invalid"), { code: "PINNED_FIXTURE_REJECTED" }); };
  const incremental = { observationIndex, revision: "failed-private-1", catalog: Object.fromEntries(["readCatalog", "readCompanyCatalog", "withCatalog", "withCompanyCatalog", "stats"].map(method => [method, reject])), runs: [] };
  const wiring = buildSourceWiring({ codeRoot, copyDataDir: root, now: "2026-11-15T00:00:00.000Z", incremental });
  t.after(() => wiring.scheduler.close());
  await assert.rejects(wiring.sources.loadSources({ type: "keyword", targetId: "fixture", month: "2026-11", cutoffDate: "2026-11-15" }, { includeContext: false }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(originalReads, 0);
  await assert.rejects(fs.access(path.join(root, "company_master")), { code: "ENOENT" });
});
test("JavaScript guards reject network, processes and original-namespace writes before a side effect", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-guard-fixture-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const guard = installGuards(root);
  try {
    assert.throws(() => require("node:http").get("https://provider.invalid"), { code: "KEYWORD_RECONSTRUCT_NETWORK_DENIED" });
    assert.throws(() => require("node:child_process").execSync("must-not-run"), { code: "KEYWORD_RECONSTRUCT_CHILD_PROCESS_DENIED" });
    assert.throws(() => fs.writeFile(path.join(path.dirname(root), "outside-source-must-not-exist"), "no"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    assert.throws(() => fs.readFile(path.join(path.dirname(root), "unapproved-read")), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    assert.throws(() => require("node:fs").readFileSync(0), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    assert.throws(() => fs.readdir(path.dirname(root)), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    await fs.writeFile(path.join(root, "own-derived.json"), "{}");
    assert.equal(guard.metrics.networkAttempts, 1); assert.equal(guard.metrics.childProcessAttempts, 1); assert.equal(guard.metrics.outsideCopyWriteAttempts, 1); assert.equal(guard.metrics.outsideReadAttempts, 3);
  } finally { guard.restore(); }
});

test("incremental guards grant immutable state body reads and source metadata without broadening writes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-incremental-guard-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const native = require("node:fs"), copy = path.join(root, "private-job"), state = path.join(root, "state"), original = path.join(root, "source"), codeRoot = path.join(root, "code");
  await fs.mkdir(copy); await fs.mkdir(state); await fs.mkdir(original);
  await fs.mkdir(path.join(codeRoot, "scripts/lib"), { recursive: true });
  const codeFile = path.join(codeRoot, "scripts/reviewed.cjs"); await fs.writeFile(codeFile, '"use strict";');
  const shard = path.join(state, "company.json"), history = path.join(original, "observations.jsonl"), hardlink = path.join(copy, "state-hardlink.json");
  await fs.writeFile(shard, '{"companyId":"fixture"}'); await fs.writeFile(history, '{"protected":"source"}\n');
  await fs.link(shard, hardlink);
  const beforeMode = (await fs.stat(shard)).mode;
  const guard = installGuards(copy, { codeRoot, readOnlyRoots: [state], metadataOnlyFiles: [history] });
  try {
    assert.equal(await fs.readFile(shard, "utf8"), '{"companyId":"fixture"}');
    assert.deepEqual(await fs.readdir(state), ["company.json"]);
    assert.equal((await fs.stat(history)).size, 23);
    assert.equal(await fs.realpath(history), history);
    assert.throws(() => native.readFileSync(history), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    assert.throws(() => native.openSync(history, "r"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    assert.throws(() => fs.copyFile(history, path.join(copy, "forbidden-source-copy")), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
    assert.throws(() => fs.writeFile(shard, "changed"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    assert.throws(() => native.createWriteStream(shard), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    assert.throws(() => fs.writeFile(hardlink, "alias-write"), { code: "KEYWORD_RECONSTRUCT_WRITE_SYMLINK_DENIED" });
    const handle = await fs.open(shard, "r");
    try {
      await assert.rejects(handle.chmod(0o600), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
      await assert.rejects(handle.writeFile("changed"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
      assert.throws(() => native.fchmodSync(handle.fd, 0o600), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
      assert.throws(() => native.writeFileSync(handle.fd, "changed"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    } finally { await handle.close(); }
    const codeHandle = await fs.open(codeFile, "r");
    try {
      await assert.rejects(codeHandle.chmod(0o444), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
      await assert.rejects(codeHandle.truncate(0), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
      assert.throws(() => native.fchmodSync(codeHandle.fd, 0o444), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    } finally { await codeHandle.close(); }
    assert.throws(() => native.createWriteStream(codeFile), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    await fs.writeFile(path.join(copy, "derived.json"), "{}");
    assert.throws(() => native.readFileSync(path.join(root, "not-approved")), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" });
  } finally { guard.restore(); }
  assert.equal(await fs.readFile(shard, "utf8"), '{"companyId":"fixture"}');
  assert.equal(await fs.readFile(history, "utf8"), '{"protected":"source"}\n');
  assert.equal((await fs.stat(shard)).mode, beforeMode);
  assert.equal(await fs.readFile(codeFile, "utf8"), '"use strict";');
});
test("public projection removes private fields recursively while retaining safe quantity and valuation evidence", () => {
  const removed = {}, row = { companyId: "cmp_1", phoneBookings: 3, phoneRevenue: 600000, capacityBasis: { count: 15, label: "saved", currentObservedMaximum: 26 },
    phonePriceEstimates: [{ revenue: 600000, productKey: "room1" }], guestName: "fixture", nested: { address: "private fixture", token: "private fixture" } };
  const safe = publicSource(row, removed); assert.equal(safe.phoneBookings, 3); assert.equal(safe.phoneRevenue, 600000);
  assert.deepEqual(safe.capacityBasis, row.capacityBasis); assert.deepEqual(safe.phonePriceEstimates, row.phonePriceEstimates);
  assert.equal(Object.hasOwn(safe, "guestName"), false); assert.deepEqual(safe.nested, {}); assert.equal(Object.keys(removed).length, 3);
});
test("reconstruction requires a fingerprinted physical capture and an explicit kernel proof", () => {
  assert.throws(() => args(["--copy-root", path.resolve("fixture")]), { code: "KEYWORD_RECONSTRUCT_ARGUMENTS" });
  assert.equal(typeof snapshotCore, "function");
});
