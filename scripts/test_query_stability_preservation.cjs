"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), base = "ab75399f8f52acde6fccdfe5c425dc96adfcf207";
const digest = value => crypto.createHash("sha256").update(value.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
const text = value => value.toString("utf8").replace(/\r\n/g, "\n");
const original = file => text(execFileSync("git", ["show", `${base}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }));
const current = file => text(fs.readFileSync(path.join(root, file)));
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, "approved baseline fragment must be unique");
  return source.replace(before, after);
}

test("freshness recovery preserves source math, room reviews, recurring and collector protections exactly", () => {
  // Lifecycle wiring and bootstrap scheduling below are explicitly approved
  // runtime edits. Their existing file-based cache fingerprints may change
  // once; this test does not pretend those fingerprints were preserved.
  const files = ["scripts/lib/monthly_reports.cjs",
    "scripts/lib/monthly_report_comparison.cjs", "scripts/lib/monthly_report_insights.cjs",
    "scripts/lib/company_capacity_registry.cjs",
    "scripts/inventory_estimation.cjs", "scripts/verified_room_inventory.json",
    "scripts/lib/keyword_monthly_incremental_state.cjs",
    "scripts/lib/insight_recurring_collection.cjs", "scripts/lib/insight_store.cjs",
    "scripts/collection_rotation_scheduler.cjs", "scripts/keyword_worker_scheduler.cjs",
    "scripts/daily_keyword_collection_scheduler.cjs", "scripts/naver_request_pacing.cjs",
    "scripts/collector_requests.cjs", "scripts/collector_broker.cjs", "scripts/collector_worker.cjs",
    "web/keyword-monthly-benchmark.js", "web/keyword-monthly-dashboard-model.js"];
  for (const file of files) {
    assert.equal(digest(current(file)), digest(original(file)), file);
  }
});

test("appserver differs from the production base only by explicit shutdown and conversion-admission wiring", () => {
  const file = "scripts/glamping_app_server.cjs";
  let expected = original(file);
  expected = replaceOnce(expected,
    'const { createRuntimeResponsiveness } = require("./lib/runtime_responsiveness.cjs");',
    'const { createRuntimeResponsiveness } = require("./lib/runtime_responsiveness.cjs");\nconst { installApplicationShutdown } = require("./lib/application_shutdown.cjs");\nconst { readPreparedConversionAdmission } = require("./lib/keyword_monthly_maintenance.cjs");');
  expected = replaceOnce(expected,
    '  cooperativeYield: true, cooperativeCompanyMonthYield: true });',
    '  cooperativeYield: true, cooperativeCompanyMonthYield: true,\n  externalAdmission: () => readPreparedConversionAdmission({ dataDir: DATA_DIR }) });');
  expected = replaceOnce(expected,
    'server.once("close", () => searchDemandScheduler.stop());',
    'server.once("close", () => searchDemandScheduler.stop());\ninstallApplicationShutdown({ server, closeDerivedWork: () => keywordMonthlyRefreshIntegration.close() });');
  assert.equal(digest(current(file)), digest(expected), "no unrelated routes, source callbacks, schedules or startup mutations are approved");
});

test("refresh integration changes only propagation of the existing worker abort signal to queued admission", () => {
  const file = "scripts/lib/keyword_monthly_refresh_integration.cjs";
  const expected = replaceOnce(original(file),
    '    }, { priority: "background", kind: "keyword_monthly_refresh" }), now',
    '    }, { priority: "background", kind: "keyword_monthly_refresh", signal: work.signal }), now');
  assert.equal(digest(current(file)), digest(expected), "evidence validation, reconciliation, original receipts and publication checks remain exact");
});

test("company engine changes only bounded bootstrap yielding and numeric phase inspection", () => {
  const file = "scripts/lib/company_integrated_db.cjs";
  let expected = original(file);
  const approved = [
    ['  runNonInterruptibleCooperativeWork } = require("./cooperative_work_checkpoint.cjs");',
      '  runNonInterruptibleCooperativeWork } = require("./cooperative_work_checkpoint.cjs");\nconst { getAnalyticalPhaseDiagnostics } = require("./analytical_phase_runtime.cjs");'],
    ['calculationVersion = CALCULATION_VERSION, autoStart = true, runWork = operation => operation() } = {}) {',
      'calculationVersion = CALCULATION_VERSION, autoStart = true, runWork = operation => operation(),\n  bootstrapCheckpoint = () => new Promise(resolve => setImmediate(resolve)) } = {}) {'],
    ['  if (readRevision !== undefined && typeof readRevision !== "function") throw new TypeError("readRevision must be a function");',
      '  if (readRevision !== undefined && typeof readRevision !== "function") throw new TypeError("readRevision must be a function");\n  if (typeof bootstrapCheckpoint !== "function") throw new TypeError("Bootstrap checkpoint must be a function");'],
    ['  async function readMetadataRevisions() {\n    const data = await catalog(), revisions = new Map();\n    for (const company of data.companies || []) {',
      '  async function readMetadataRevisions(checkpoint = null) {\n    const data = await catalog(), revisions = new Map();\n    for (const company of data.companies || []) {\n      if (checkpoint) await checkpoint();'],
    ['        const targets = await listTargets({}), metadata = readRevision ? await readMetadataRevisions() : null,\n          prepared = await prepareRevision(), grouped = new Map();\n        for (const target of targets) {',
      '        const phases = getAnalyticalPhaseDiagnostics(), counts = { rowCount: 0 };\n        const { targets, metadata } = await phases.measure("bootstrap_targets_metadata", counts, async () => ({\n          targets: await listTargets({}), metadata: readRevision ? await readMetadataRevisions(bootstrapCheckpoint) : null\n        }));\n        const prepared = await phases.measure("bootstrap_revision_prepare", {}, () => prepareRevision()), grouped = new Map();\n        for (const target of targets) {\n          await bootstrapCheckpoint();'],
    ['        if (metadata) for (const id of metadata.keys()) if (!grouped.has(id)) {',
      '        if (metadata) for (const id of metadata.keys()) if (!grouped.has(id)) {\n          await bootstrapCheckpoint();'],
    ['        let queued = 0, reused = 0, refreshedMonths = 0, recovered = 0;\n        for (const [id, observedMonths] of grouped) {',
      '        let queued = 0, reused = 0, refreshedMonths = 0, recovered = 0;\n        await phases.measure("bootstrap_saved_months", counts, async () => {\n        for (const [id, observedMonths] of grouped) {\n          await bootstrapCheckpoint();'],
    ['          const changed = [];\n          for (const month of months) {',
      '          const changed = [];\n          for (const month of months) {\n            // Filesystem reads may complete from cache in consecutive promise\n            // turns. Always give health/status sockets a turn between complete\n            // company-month integrity checks; no partial proof is published.\n            await bootstrapCheckpoint(); counts.rowCount++;'],
    ['        }\n        if (prepared) {\n          const checked = await prepareRevision();',
      '        }\n        });\n        if (prepared) {\n          await bootstrapCheckpoint();\n          const checked = await phases.measure("bootstrap_revision_recheck", {}, () => prepareRevision());'],
    ['        await locked(async () => { state.bootstrap = { ...result, status: "checked", checkedAt: current().toISOString(), errorCode: null,\n          failureGeneration: state.bootstrap?.failureGeneration || 0 }; await saveState(); });',
      '        await phases.measure("bootstrap_state_publish", {}, () => locked(async () => { state.bootstrap = { ...result, status: "checked", checkedAt: current().toISOString(), errorCode: null,\n          failureGeneration: state.bootstrap?.failureGeneration || 0 }; await saveState(); }));']
  ];
  for (const [before, after] of approved) expected = replaceOnce(expected, before, after);
  const actual = current(file);
  assert.equal(digest(actual), digest(expected), "math, capacity, selected observations, source checks and result publication outside these exact edits remain unchanged");
  const bootstrap = actual.slice(actual.indexOf("  function bootstrap() {"), actual.indexOf("  async function materialize("));
  for (const phase of ["bootstrap_targets_metadata", "bootstrap_revision_prepare", "bootstrap_saved_months", "bootstrap_revision_recheck", "bootstrap_state_publish"]) {
    assert.equal(bootstrap.split(`phases.measure("${phase}"`).length, 2, "one bounded diagnostic per bootstrap subphase");
  }
  assert.match(bootstrap, /await bootstrapCheckpoint\(\); counts\.rowCount\+\+;\n\s+const cutoffDate/);
  assert.match(bootstrap, /if \(await reusable\(stored, id, month, cutoffDate, revision, metadata\?\.get\(id\)\)\) reused\+\+;/);
  assert.match(bootstrap, /if \(!checked \|\| checked\.revision !== prepared\.revision\) throw fault\("COMPANY_INTEGRATION_SOURCE_CHANGED"\)/);
  assert.match(bootstrap, /priority: "background", kind: "company-bootstrap", detached: true/);
});

test("admin-only phase diagnostics are bounded numeric inspection and do not invoke analysis", async () => {
  const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
  const { getAnalyticalPhaseDiagnostics } = require("./lib/analytical_phase_runtime.cjs");
  const diagnostics = getAnalyticalPhaseDiagnostics();
  const expected = new Error("private operation details");
  await assert.rejects(async () => diagnostics.run("keyword_monthly_analysis", () => diagnostics.measure("keyword_projection_read", {
    inputBytes: 4096, sourceText: "private property values", token: "private credential"
  }, () => { throw expected; })), error => error === expected);
  let sourceCalls = 0, statusReads = 0;
  const handler = createKeywordMonthlyHttpHandler({
    service: { options() { sourceCalls++; throw Error("not a status read"); }, analyze() { sourceCalls++; } },
    requireAdmin: session => session.admin === true,
    readRefreshStatus: async () => { statusReads++; return { started: false, currentVersionCounts: {} }; },
    send: (response, status, body) => Object.assign(response, { status, body })
  });
  const run = async (admin, method = "GET") => {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    await handler({ method }, response, new URL("https://example.test/api/keyword-monthly/refresh-status"), { admin });
    return response;
  };
  const denied = await run(false); assert.equal(denied.body, undefined); assert.equal(statusReads, 0);
  assert.equal((await run(true, "POST")).status, 405); assert.equal(statusReads, 0);
  const response = await run(true); assert.equal(response.status, 200);
  assert.equal(response.body.started, false); assert.equal(sourceCalls, 0); assert.equal(statusReads, 1);
  const encoded = JSON.stringify(response.body.phaseDiagnostics);
  for (const secret of ["private operation details", "private property values", "private credential"]) assert.ok(!encoded.includes(secret));
  assert.ok(encoded.length < 512 * 1024);
  assert.equal(response.headers["Cache-Control"], "private, no-store");
});
