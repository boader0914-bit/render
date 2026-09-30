"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const { sanitizeProductStockCorrections, applyProductStockCorrections } = require("./lib/inventory_manual_corrections.cjs");

const correction = { bizItemId: "7106894", stayDate: "2026-09-26", observedStock: 7, correctedStock: 6, reason: "업주 확인: 스위트 재고 7은 설정 실수이며 실제 6실" };
const product = (extra = {}) => ({ bizItemId: "7106894", name: "스위트", saleType: "숙박", date: "2026-09-26", stock: 7, bookingCount: 1, occupiedBookingCount: 0, price: 200000, ...extra });
const fixture = () => ({ name: "월명글램핑", placeId: "35644668", checkIn: "2026-09-26", bookingRangeDays: 3,
  inventoryCapacityBaseline: { companyId: "cmp_place_35644668", lodging: 17, lodgingOverride: { count: 16 }, productStockCorrections: [correction] },
  weeklyProductDetails: ["2026-09-26", "2026-09-27", "2026-09-28"].flatMap((date) => [
    ...[2, 4, 2, 2].map((stock, index) => product({ bizItemId: `room_${index}`, name: `다른 객실 ${index}`, date, stock, bookingCount: 0 })),
    product({ date, stock: date === "2026-09-26" ? 7 : date === "2026-09-27" ? 6 : 0, bookingCount: date === "2026-09-26" ? 1 : 0 })
  ]) });

test("owner correction preserves original evidence and recalculates revenue by the corrected product capacity", () => {
  const input = fixture(), before = JSON.stringify(input);
  const result = applyInventoryEvidence(input), rows = result.inventoryEvidence.lodging.rows;
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.weeklyProductDetails[4].stock, 7, "provider evidence remains untouched");
  assert.equal(rows[0].rawTotal, 16);
  assert.equal(rows[0].available, 15);
  assert.equal(rows[0].publicBookings, 1);
  assert.equal(rows[0].publicRevenue, 200000);
  assert.equal(rows[0].capacityConflict, false);
  assert.equal(rows[1].phoneBookings, 0, "do not infer a seventeenth room");
  assert.equal(rows[2].phoneBookings, 6);
  assert.equal(rows[2].phoneRevenue, 1200000, "the corrected six-room product can price its own shortage");
  assert.equal(result.inventoryEvidence.normalizationEvidence.length, 1);
  assert.deepEqual(result.inventoryEvidence.normalizationEvidence[0].source, { stock: 7 });
  assert.deepEqual(result.inventoryEvidence.normalizationEvidence[0].applied, { stock: 6 });
  assert.equal(applyInventoryEvidence(result), result, "reprojection is idempotent");
});

test("scope requires exact product, stay date, original stock and lodging kind", () => {
  const inputs = [product({ bizItemId: "other" }), product({ bizItemId: undefined, key: "7106894" }), product({ date: "2026-09-27" }), product({ stock: 8 }), product({ stock: 6 }), product({ saleType: "데이유즈" })];
  for (const row of inputs) {
    const result = applyInventoryEvidence({ inventoryCapacityBaseline: { productStockCorrections: [correction] }, weeklyProductDetails: [row] });
    assert.deepEqual(result.inventoryEvidence.normalizationEvidence, []);
  }
  const otherCompany = fixture();
  otherCompany.placeId = "different_company";
  otherCompany.inventoryCapacityBaseline = { companyId: "different_company", lodging: 17 };
  assert.equal(applyInventoryEvidence(otherCompany).inventoryEvidence.lodging.rows[0].rawTotal, 17, "no globally shared product correction");
});

test("failed or missing observations cannot become corrected healthy observations", () => {
  for (const extra of [{ collectionFailed: true }, { missing: true }, { bookingCount: null }, { bookingCount: false }, { bookingCount: " " }, { stock: null }]) {
    const row = product(extra);
    const result = applyProductStockCorrections([row], [correction]);
    assert.equal(result.rows[0], row);
    assert.equal(result.normalizationEvidence.length, 0);
  }
  const result = applyInventoryEvidence({ inventoryCapacityBaseline: { lodgingOverride: { count: 6 }, productStockCorrections: [correction] }, weeklyProductDetails: [product({ collectionFailed: true })] });
  assert.equal(result.inventoryEvidence.lodging.rows[0].missing, true);
  assert.equal(result.inventoryEvidence.lodging.rows[0].phoneBookings, 0);
});

test("overbooked source remains a conflict and never clamps public reservations", () => {
  const row = product({ bookingCount: 7 });
  const result = applyInventoryEvidence({ inventoryCapacityBaseline: { lodgingOverride: { count: 6 }, productStockCorrections: [correction] }, weeklyProductDetails: [row] });
  const daily = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.stock, 7);
  assert.equal(daily.publicBookings, 7);
  assert.equal(daily.publicRevenue, 1400000);
  assert.equal(daily.inventoryConflict, true);
  assert.equal(daily.rate, null);
  assert.equal(daily.phoneBookings, 0);
});

test("correction validation rejects malformed and ambiguous rules", () => {
  assert.deepEqual(sanitizeProductStockCorrections(), []);
  assert.deepEqual(sanitizeProductStockCorrections([correction]), [correction]);
  const invalid = [null, {}, "", [null], [{ ...correction, stayDate: "2026-02-30" }], [{ ...correction, stayDate: "26-09-26" }],
    [{ ...correction, observedStock: "7" }], [{ ...correction, correctedStock: 0 }], [{ ...correction, correctedStock: -1 }],
    [{ ...correction, correctedStock: 1.5 }], [{ ...correction, correctedStock: 10001 }], [{ ...correction, correctedStock: 7 }],
    [{ ...correction, bizItemId: "" }], [{ ...correction, reason: " " }], [{ ...correction, unexpected: true }], [correction, correction]];
  for (const value of invalid) assert.throws(() => sanitizeProductStockCorrections(value), (error) => error.statusCode === 400 && error.code === "INVALID_PRODUCT_STOCK_CORRECTION");
  const later = { ...correction, stayDate: "2026-10-01" };
  assert.deepEqual(sanitizeProductStockCorrections([later, correction]), [correction, later]);
});

test("server save preserves product corrections on ordinary edits, validates before mutation and audits explicit clears", async () => {
  const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const start = source.indexOf("async function saveCompanyManualCorrectionUnlocked(");
  assert.ok(start >= 0);
  const next = /\n(?:async )?function /.exec(source.slice(start + 1));
  assert.ok(next);
  const companyId = "cmp_place_35644668";
  let master = { companies: { [companyId]: { companyId, manualCorrection: null } } }, writes = 0;
  // Exercise the production persistence function with memory-only I/O. Other
  // field sanitizers are outside this contract; the new strict sanitizer is real.
  const context = vm.createContext({ sanitizeProductStockCorrections, structuredClone,
    readCompanyMaster: async () => master,
    writeCompanyMaster: async (value) => { master = value; writes++; },
    summarizeCompanyMaster: async () => ({}), companyRecordSummary: (company) => company,
    sanitizeManualCorrectionRoomSegments: (value) => value || [], sanitizeManualCorrectionMeta: () => ({}),
    manualCorrectionHasValue: (value) => Number(value.lodgingBasisTotal) > 0
  });
  vm.runInContext(source.slice(start, start + 1 + next.index), context);
  const save = context.saveCompanyManualCorrectionUnlocked;
  await save({ companyId, lodgingBasisTotal: 16, productStockCorrections: [correction], note: "업주 확인" });
  assert.deepEqual(master.companies[companyId].manualCorrection.productStockCorrections, [correction]);
  assert.deepEqual(master.companies[companyId].manualCorrectionHistory[0].productStockCorrections, [correction]);
  await save({ companyId, lodgingBasisTotal: 16, note: "메모만 변경" });
  assert.equal(writes, 2);
  assert.deepEqual(master.companies[companyId].manualCorrection.productStockCorrections, [correction], "an unrelated edit cannot silently drop a reviewed correction");
  const beforeInvalid = JSON.stringify(master);
  await assert.rejects(save({ companyId, lodgingBasisTotal: 16, productStockCorrections: [{ ...correction, correctedStock: 0 }] }), (error) => error.statusCode === 400);
  assert.equal(writes, 2);
  assert.equal(JSON.stringify(master), beforeInvalid, "invalid rules fail before any DB or history mutation");
  await save({ companyId, lodgingBasisTotal: 16, productStockCorrections: [] });
  assert.equal(master.companies[companyId].manualCorrection.productStockCorrections.length, 0, "an explicit empty list clears only product rules");
  assert.equal(master.companies[companyId].manualCorrection.lodgingBasisTotal, 16);
  await save({ companyId, lodgingBasisTotal: 16, productStockCorrections: [correction] });
  await save({ companyId, active: false });
  assert.equal(master.companies[companyId].manualCorrection, null);
  const history = master.companies[companyId].manualCorrectionHistory;
  assert.equal(history.at(-1).action, "clear");
  assert.equal(history.at(-1).productStockCorrections.length, 0);
  assert.deepEqual(history.at(-2).productStockCorrections, [correction], "the preceding reviewed rule remains in audit history");
});
