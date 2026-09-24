"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dayUsePlan, withoutUncollectedDayUse, normalizeDayUseMode } = require("./collector_day_use.cjs");
const { scope, covers } = require("./collection_reuse.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const { inspectProductCoverage } = require("./daily_collection_quality.cjs");
const { createProductCoverage } = require("./collector_product_coverage.cjs");
const classify = item => item.kind;
const items = [{ bizItemId: "night", kind: "숙박" }, { bizItemId: "day", kind: "데이유즈" }];
const listing = { items, status: 200, listObserved: true };

test("inspect is the default; day-use schedules require detail and a detail collection", () => {
  assert.equal(normalizeDayUseMode(), "inspect");
  for (const mode of ["inspect", "lodging_only", "detail"]) {
    const plan = dayUsePlan({ mode, itemResult: listing, classify });
    assert.equal(plan.presence, "present");
    assert.equal(plan.sharingStatus, "unconfirmed");
    assert.equal(plan.collectDayUseSchedules, mode === "detail");
    assert.equal(plan.eligible.length, mode === "detail" ? 2 : 1);
    assert.equal(plan.excludedDayUse, mode === "detail" ? 0 : 1);
    assert.equal(dayUsePlan({ mode, itemResult: listing, classify, collectDetail: false }).collectDayUseSchedules, false);
  }
});

test("absent requires a complete normal product list; errors, missing payload and unknown types stay unknown", () => {
  const normal = { ...listing, items: items.slice(0, 1) };
  assert.equal(dayUsePlan({ itemResult: normal, classify }).presence, "absent");
  for (const override of [{ status: 429 }, { errors: [{ message: "fixture" }] }, { listObserved: false }, { items: [{ kind: "미분류" }] }]) {
    assert.equal(dayUsePlan({ itemResult: { ...normal, ...override }, classify }).presence, "unknown");
  }
  const inactive = dayUsePlan({ itemResult: { ...listing, items: [{ ...items[1], isImp: false }] }, classify });
  assert.equal(inactive.presence, "present"); assert.equal(inactive.dayUseItems.length, 0);
});

test("unqueried day-use quantities and revenue stay null, with explicit scope exclusions in coverage", () => {
  const plan = dayUsePlan({ itemResult: listing, classify });
  const result = withoutUncollectedDayUse({ nightTotalStock: 28, dayUseEstimatedRevenue: 0, dayUseAvailableStock: 0,
    dayUseTotalStock: 0, dayUseCountedItemCount: 0, dayUseWeekly: { totalStock: 0 } }, plan);
  assert.equal(result.nightTotalStock, 28);
  for (const key of ["dayUseEstimatedRevenue", "dayUseAvailableStock", "dayUseTotalStock", "dayUseCountedItemCount", "dayUseWeekly"]) assert.equal(result[key], null);
  const coverage = createProductCoverage();
  coverage.discover("fixture", items, plan.eligible, ["2026-09-24"], { dayUseMode: "inspect", dayUsePresence: "present",
    dayUseExcludedByMode: 1, dayUseSchedulesRequested: false, productListComplete: true });
  coverage.record("fixture", plan.eligible, 40, "2026-09-24", [{ ...items[0], stock: 0 }]);
  assert.equal(inspectProductCoverage(coverage.snapshot(), true), null);
  const incomplete = coverage.snapshot(); incomplete.targets[0].productListComplete = false;
  assert.equal(inspectProductCoverage(incomplete, true), "product_list_incomplete");
});

test("day-use scope is part of reuse identity, including legacy detail receipts", () => {
  const base = { keyword: "fixture", checkIn: "2026-09-24", checkOut: "2026-09-30", bookingRangeDays: 7 };
  for (const mode of ["inspect", "lodging_only", "detail"]) {
    assert.equal(covers(scope({ ...base, dayUseMode: mode }), scope({ ...base, dayUseMode: mode })), true);
    for (const other of ["inspect", "lodging_only", "detail"].filter(value => value !== mode))
      assert.equal(covers(scope({ ...base, dayUseMode: mode }), scope({ ...base, dayUseMode: other })), false);
  }
  assert.equal(scope(base).dayUseMode, "detail");
  assert.equal(covers(scope(base), scope({ ...base, dayUseMode: "inspect" })), false);
});

test("unmeasured day use cannot inflate lodging phone-reservation estimates", () => {
  const row = { date: "2026-09-24", name: "객실", bizItemId: "night", stock: 10, bookingCount: 1, occupiedBookingCount: 4, price: 100000 };
  for (const presence of ["present", "unknown"]) {
    const result = applyInventoryEvidence({ dayUseMode: "inspect", dayUsePresence: presence, dayUseScheduleStatus: "not_requested", weeklyProductDetails: [row] });
    assert.equal(result.inventoryEvidence.lodging.phoneBookings, 0);
    assert.equal(result.inventoryEvidence.lodging.publicBookings, 1);
    assert.equal(result.inventoryEvidence.lodging.unknownUnavailable, 4);
    assert.equal(result.inventoryEvidence.dayUse, null);
  }
  const absent = applyInventoryEvidence({ dayUseMode: "inspect", dayUsePresence: "absent", dayUseScheduleStatus: "not_requested", weeklyProductDetails: [row] });
  assert.equal(absent.inventoryEvidence.lodging.phoneBookings, 4);
  const separate = applyInventoryEvidence({ dayUseMode: "lodging_only", dayUsePresence: "present", dayUseScheduleStatus: "excluded", sharedRooms: { status: "confirmed_separate" }, weeklyProductDetails: [row] });
  assert.equal(separate.inventoryEvidence.lodging.phoneBookings, 4);
});
