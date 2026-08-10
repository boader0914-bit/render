"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "worker projection UI fixtures" });
try {
  const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  assert.match(app, /function runDbApplyStatusModel[\s\S]*?workerProjection[\s\S]*?projection_pending/u);
  assert.match(app, /workerProjectionReconcile[\s\S]*?reconcileWorkerRunProjection/u);
  assert.match(app, /function renderDownloads\(\)[\s\S]*?검증된 산출물/u);
  assert.doesNotMatch(app, /checkOutInput\.readOnly\s*=\s*true/u);
  assert.match(app, /function collectionDateRangeIsValid[\s\S]*?bookingRangeDays <= 7/u);
  assert.match(app, /function syncCollectionDateRangeValidity[\s\S]*?dateRangeDisabled/u);
  assert.match(app, /function top20CollectionRangeLabel[\s\S]*?bookingRangeDays/u);
  assert.match(html, /<span id="checkInLabel">수집 시작일<\/span>[\s\S]{0,240}?id="checkInInput"/u);
  assert.match(html, /<span id="checkOutLabel">수집 종료일<\/span>[\s\S]{0,240}?id="checkOutInput"/u);
  assert.match(server, /collection-worker\/run-projection\/reconcile/u);
  assert.match(server, /if \(workerRun\)[\s\S]{0,1800}?projectionApplication/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log(JSON.stringify({
    workerStatusPriority: true,
    manualReconcileAction: true,
    signedDownloadsOnly: true,
    dateRangeEditable: true,
    dateRangeLabels: true,
    externalNetworkCalls: 0
  }));
} finally {
  guard.restore();
}
