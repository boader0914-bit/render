"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const room = (date, id, extra = {}) => ({ date, bizItemId: id, name: id, saleType: "숙박", stock: 1, bookingCount: 0, occupiedBookingCount: 0, price: 259000, open: false, collectionFailed: false, ...extra });
const unknownDayUse = { dayUseItemCount: 2, dayUsePresence: "present", dayUseScheduleStatus: "skipped_by_mode" };

test("explicit blocked inventory retains revenue with unobserved day use; an aggregate gap remains unknown", () => {
  const value = applyInventoryEvidence({ ...unknownDayUse, inventoryCapacityBaseline: { lodging: 5 }, weeklyProductDetails: [
    room("2026-09-24", "closed"),
    room("2026-09-24", "occupied", { open: true, occupiedBookingCount: 1 }),
    room("2026-09-24", "public", { open: true, bookingCount: 1 })
  ] });
  const day = value.inventoryEvidence.lodging.rows[0];
  assert.deepEqual([day.publicBookings, day.phoneBookings, day.explicitBlockedBookings, day.unknownUnavailable], [1, 2, 2, 2]);
  assert.deepEqual([day.publicRevenue, day.phoneRevenue, day.explicitBlockedRevenue, day.estimatedRevenue], [259000, 518000, 518000, 777000]);
  assert.equal(day.sharedDayUseIncomplete, true);
  assert.equal(day.explicitBlockedDayUseUnverified, true);
  assert.equal(day.partial, true);
  assert.equal(day.rate, null);
  assert.equal(value.weeklyAvgReservationRate, null);
  assert.equal(value.weeklyExplicitBlockedRevenue, 518000);
});

test("known shared day-use reservations are excluded before valuing explicit blocked rooms", () => {
  const value = applyInventoryEvidence({ sharedRooms: { status: "confirmed" }, weeklyProductDetails: [
    room("2026-09-24", "cheap", { price: 100000 }),
    room("2026-09-24", "expensive", { price: 300000 }),
    room("2026-09-24", "day", { saleType: "데이유즈", bookingCount: 1, open: true, price: 50000 })
  ] });
  const day = value.inventoryEvidence.lodging.rows[0];
  assert.equal(day.sharedDayUseExcluded, 1);
  assert.equal(day.phoneBookings, 1);
  assert.equal(day.explicitBlockedBookings, 1);
  assert.equal(day.phoneRevenue, 100000, "Unknown room identity uses a lower estimate after shared-room deduction");
  assert.equal(value.dayUseWeeklyAdjustedRevenue, 50000);
});

test("overlapping historical product maxima cannot erase directly observed blocked revenue", () => {
  const value = applyInventoryEvidence({ weeklyProductDetails: [
    room("2026-09-24", "first", { stock: 8, price: 100000 }), room("2026-09-24", "second", { stock: 2, price: 100000 }),
    room("2026-09-25", "first", { stock: 2, price: 100000 }), room("2026-09-25", "second", { stock: 8, price: 100000 })
  ] });
  assert.equal(value.totalRooms, 10);
  assert.equal(value.weeklyPhoneBookings, 20);
  assert.equal(value.weeklyPhoneRevenue, 2000000);
  assert.equal(value.weeklyExplicitBlockedRevenue, 2000000);
});

test("failed, blocked and absent observations cannot become blocked revenue while a healthy product remains usable", () => {
  const value = applyInventoryEvidence({ ...unknownDayUse, inventoryCapacityBaseline: { lodging: 4 }, weeklyProductDetails: [
    room("2026-09-24", "healthy"),
    room("2026-09-24", "failed", { stock: 0, bookingCount: 0, collectionFailed: true }),
    room("2026-09-24", "blocked", { stock: 1, bookingCount: 0, collectionFailed: true }),
    room("2026-09-24", "missing", { stock: null, bookingCount: null })
  ] });
  assert.equal(value.weeklyPhoneBookings, 1);
  assert.equal(value.weeklyPhoneRevenue, 259000);
  assert.equal(value.weeklyUnknownUnavailable, 3);
});

function numberedFixture() {
  const names = [...Array.from({ length: 10 }, (_, i) => `A-${i + 1}${i === 4 ? "번" : ""}(BBQ무한리필+조식)`), ...Array.from({ length: 7 }, (_, i) => `B-${i + 1}(BBQ무한리필+조식)` )];
  return { ...unknownDayUse, inventoryCapacityBaseline: { lodgingOverride: { count: 17, source: "db_manual_correction" } }, weeklyProductDetails: [
    ...names.map((name, i) => room("2026-09-24", `room-${i}`, { name, bookingCount: i < 8 ? 1 : 0, open: i < 8 })),
    room("2026-09-24", "guide", { name: "현장예약 및 전화예약", stock: 17, bookingCount: 17, price: 0 }),
    ...names.map((name, i) => room("2026-09-26", `room-${i}`, { name, stock: i === 8 ? 2 : 1, bookingCount: i === 8 ? 2 : 0, open: i === 8 })),
    room("2026-09-26", "guide", { name: "현장예약 및 전화예약", stock: 17, bookingCount: 17, price: 0 })
  ] };
}

test("a reviewed 17-room numbered set excludes its phone guide and normalizes duplicated unit counts without mutating source", () => {
  const input = numberedFixture();
  const before = JSON.stringify(input);
  const value = applyInventoryEvidence(input);
  assert.equal(JSON.stringify(input), before);
  const evidence = value.inventoryEvidence;
  assert.equal(evidence.capacityBasis.count, 17);
  assert.equal(evidence.capacityBasis.currentObservedMaximum, 17);
  assert.equal(evidence.excludedNonRoomProductCount, 1);
  assert.equal(evidence.exclusionEvidence.length, 2);
  assert.equal(evidence.exclusionEvidence[0].bookingCount, 17);
  assert.equal(evidence.normalizationEvidence.length, 1);
  assert.deepEqual(evidence.normalizationEvidence[0].source, { stock: 2, bookingCount: 2 });
  assert.deepEqual(evidence.normalizationEvidence[0].applied, { stock: 1, bookingCount: 1 });
  assert.deepEqual([evidence.lodging.rows[0].publicBookings, evidence.lodging.rows[0].phoneBookings, evidence.lodging.rows[0].estimatedRevenue], [8, 9, 4403000]);
  assert.equal(evidence.lodging.rows.find((row) => row.date === "2026-09-26").publicBookings, 1);
  assert.equal(applyInventoryEvidence(value), value);
});

test("unreviewed, incomplete or ambiguously numbered room sets are never normalized to one room", () => {
  for (const modify of [
    (input) => { delete input.inventoryCapacityBaseline; },
    (input) => { input.inventoryCapacityBaseline.lodgingOverride.count = 18; },
    (input) => { input.weeklyProductDetails = input.weeklyProductDetails.filter((row) => row.bizItemId !== "room-16"); },
    (input) => { input.weeklyProductDetails = input.weeklyProductDetails.map((row) => row.bizItemId === "room-16" ? { ...row, name: "객실 묶음 상품" } : row); }
  ]) {
    const input = numberedFixture(); modify(input);
    assert.equal(applyInventoryEvidence(input).inventoryEvidence.normalizationEvidence.length, 0);
  }
});

test("phone wording alone and positive-price products do not qualify for non-room exclusion", () => {
  for (const extra of [
    { name: "현장예약 및 전화예약", price: 50000 },
    { name: "A-1 전화예약 가능", price: 0 },
    { name: "전화예약", price: 0 }
  ]) {
    const value = applyInventoryEvidence({ weeklyProductDetails: [room("2026-09-24", "room"), room("2026-09-24", "guide", extra)] });
    assert.equal(value.inventoryEvidence.excludedNonRoomProductCount, 0);
  }
  const alone = applyInventoryEvidence({ weeklyProductDetails: [room("2026-09-24", "guide", { name: "현장예약 및 전화예약", price: 0 })] });
  assert.equal(alone.inventoryEvidence.excludedNonRoomProductCount, 0);
  assert.equal(alone.weeklyPhoneRevenue, 0);
});
