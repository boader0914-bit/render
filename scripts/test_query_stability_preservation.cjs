"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), base = "d052b02e0b147ccd1cfc796c8638ed94bfdc8c3f";
const digest = value => crypto.createHash("sha256").update(value.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

test("first stability bundle preserves calculation fingerprints, source math, publication and recurring protections", () => {
  // The application file participates in cache versions. A metrics-only
  // server edit would otherwise invalidate existing company result caches.
  const files = ["scripts/glamping_app_server.cjs", "scripts/lib/monthly_reports.cjs",
    "scripts/lib/monthly_report_comparison.cjs", "scripts/lib/monthly_report_insights.cjs",
    "scripts/lib/company_integrated_db.cjs", "scripts/lib/company_capacity_registry.cjs",
    "scripts/inventory_estimation.cjs", "scripts/verified_room_inventory.json",
    "scripts/lib/keyword_monthly_refresh_integration.cjs", "scripts/lib/keyword_monthly_incremental_state.cjs",
    "scripts/lib/insight_recurring_collection.cjs", "scripts/lib/insight_store.cjs",
    "scripts/collection_rotation_scheduler.cjs", "scripts/keyword_worker_scheduler.cjs",
    "scripts/daily_keyword_collection_scheduler.cjs", "scripts/naver_request_pacing.cjs",
    "scripts/collector_requests.cjs", "scripts/collector_broker.cjs", "scripts/collector_worker.cjs",
    "web/keyword-monthly-benchmark.js", "web/keyword-monthly-dashboard-model.js"];
  for (const file of files) {
    const original = execFileSync("git", ["show", `${base}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(digest(fs.readFileSync(path.join(root, file))), digest(original), file);
  }
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
