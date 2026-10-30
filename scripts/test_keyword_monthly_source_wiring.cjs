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
