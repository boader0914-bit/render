"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createProductCoverage } = require("./collector_product_coverage.cjs");
const { inspectManifest, inspectProductCoverage, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");

function fixture() {
  const tracker = createProductCoverage();
  const items = [{ bizItemId: "one" }, { bizItemId: "two" }];
  tracker.discover("biz", [...items, { bizItemId: "hidden" }], items, ["2026-09-23", "2026-09-24"]);
  for (const date of ["2026-09-23", "2026-09-24"]) tracker.record("biz", items, 40, date, items.map(item => ({ ...item, stock: 0 })));
  return {
    schemaVersion: 2, workerCollection: true,
    collectionProfileFlags: { collectBookingStock: true }, naverAttemptedQueries: [{ status: 200 }],
    counts: { naverOverall: 1, naverBookingStockEligible: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1,
      naverOtaObservationChecked: 1, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 4, naverScheduleSucceeded: 4, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    productCoverage: tracker.snapshot()
  };
}

test("schema 2 needs full per-date coverage; observed zero is a complete observation", () => {
  const manifest = fixture();
  assert.equal(inspectManifest(manifest).status, "complete");
  assert.equal(allowsDerivedUpdates(manifest), true);
  assert.equal(manifest.productCoverage.discovered, 3);
  assert.equal(manifest.productCoverage.excluded, 1);
  delete manifest.productCoverage;
  assert.equal(inspectManifest(manifest).reason, "product_coverage_missing");
  assert.equal(allowsDerivedUpdates(manifest), false);
  delete manifest.schemaVersion;
  assert.equal(inspectManifest(manifest).status, "complete");
});

test("truncated and failed daily targets cannot masquerade as complete despite successful place counts", () => {
  const truncated = fixture();
  Object.assign(truncated.productCoverage, { truncated: 1 });
  truncated.productCoverage.targets[0].truncated = 1;
  assert.equal(inspectManifest(truncated).reason, "product_targets_truncated");
  assert.equal(allowsDerivedUpdates(truncated), false);
  const failed = fixture();
  Object.assign(failed.productCoverage.targets[0].days[1], { succeeded: 1, failed: 1 });
  assert.equal(inspectManifest(failed).reason, "product_day_targets_incomplete");
  assert.equal(allowsDerivedUpdates(failed), false);
  const missing = fixture();
  Object.assign(missing.productCoverage.targets[0].days[1], { queried: 0, succeeded: 0 });
  assert.equal(inspectManifest(missing).reason, "product_day_targets_incomplete");
  const missingDate = fixture(); missingDate.productCoverage.targets[0].days.pop();
  assert.equal(inspectManifest(missingDate).reason, "product_coverage_invalid");
});

test("coverage snapshots expose untouched dates and do not count gate-cancelled work as queried", () => {
  const tracker = createProductCoverage();
  const items = [{ bizItemId: "one" }, { bizItemId: "two" }];
  tracker.discover("biz", items, items, ["2026-09-23", "2026-09-24"]);
  tracker.record("biz", items, 40, "2026-09-23", [{ bizItemId: "one", stock: null, collectionFailed: true }, { bizItemId: "two", stock: null, collectionFailed: true, queryAttempted: false }]);
  const coverage = tracker.snapshot();
  assert.equal(coverage.queried, 1);
  assert.equal(coverage.targets[0].days[0].failed, 1);
  assert.equal(coverage.targets[0].days[1].queried, 0);
  assert.equal(inspectProductCoverage(coverage, true), "product_targets_incomplete");
});

test("HTTP 200 captcha blocks derived updates independently of successful coverage", () => {
  const manifest = fixture();
  manifest.requestPacing = { guardEnabled: true, blockedStatus: 200, blockedCode: "NAVER_CAPTCHA" };
  assert.equal(inspectManifest(manifest).status, "blocked");
  assert.equal(inspectManifest(manifest).blockedReason, "naver_captcha");
  assert.equal(allowsDerivedUpdates(manifest), false);
});

test("duplicate place identities sharing one booking business do not inflate coverage", () => {
  const tracker = createProductCoverage();
  const items = [{ bizItemId: "one" }, { bizItemId: "two" }];
  for (let index = 0; index < 2; index++) {
    tracker.discover("shared-biz", items, items, ["2026-09-23"]);
    tracker.record("shared-biz", items, 40, "2026-09-23", items.map(item => ({ ...item, stock: 0 })));
  }
  const coverage = tracker.snapshot();
  assert.equal(coverage.eligible, 2);
  assert.equal(coverage.targets[0].days[0].queried, 2);
  assert.equal(inspectProductCoverage(coverage, true), null);
});
