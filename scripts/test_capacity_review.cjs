"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyInventoryEvidence, buildCapacityReview, buildStoredCapacityReview } = require("./inventory_estimation.cjs");
const row = (extra = {}) => ({ bizItemId: "room1", date: "2026-09-28", name: "글램핑 A1동", saleType: "숙박", stock: 1, bookingCount: 0, price: 100000, ...extra });
const item = (extra = {}) => ({ name: "검수 글램핑", bookingBusinessId: "biz1", weeklyProductDetails: [row()], ...extra });
const reviewOf = (value) => applyInventoryEvidence(value).inventoryEvidence.capacityReview;
const reason = (review, code) => review.reasons.find((entry) => entry.code === code);

test("large observation warns without capping inventory or changing successful collection state", () => {
  const source = item({ collectionQuality: { status: "complete" }, weeklyProductDetails: [row({ stock: 45, bookingCount: 3 })] });
  const before = JSON.stringify(source), result = applyInventoryEvidence(source), review = result.inventoryEvidence.capacityReview;
  assert.equal(result.totalRooms, 45);
  assert.equal(result.weeklyPublicRevenue, 300000);
  assert.equal(review.capacityUncertain, true);
  assert.equal(review.level, "warning");
  assert.equal(review.basis, "observed_maximum");
  assert.equal(reason(review, "glamping_observed_over_40").evidence.observedMaximum, 45);
  assert.deepEqual(result.collectionQuality, { status: "complete" });
  assert.equal(JSON.stringify(source), before);
  assert.equal(applyInventoryEvidence(result), result);
});

test("a consistent DB reviewed exception remains trusted, including more than forty rooms", () => {
  const value = item({ inventoryCapacityBaseline: { lodgingOverride: { count: 50 } }, weeklyProductDetails: [row({ stock: 50 })] });
  const review = reviewOf(value);
  assert.equal(review.reviewed, true);
  assert.equal(review.basis, "db_correction");
  assert.equal(review.capacityUncertain, false);
  assert.equal(review.required, false);
  assert.equal(reason(review, "glamping_observed_over_40"), undefined);
});

test("same dated physical-room names identify general and multi-night candidate products only", () => {
  const source = item({ weeklyProductDetails: [row(), row({ bizItemId: "night2", name: "[연박특가] 글램핑 A1동" })] });
  const result = applyInventoryEvidence(source), review = result.inventoryEvidence.capacityReview;
  assert.equal(result.totalRooms, 2, "warning cannot merge products or change the existing count");
  assert.equal(reason(review, "duplicate_room_product_names").evidence.candidateGroups, 1);
  assert.equal(review.capacityUncertain, true);
  const db = reviewOf({ ...source, inventoryCapacityBaseline: { lodgingOverride: { count: 2 } } });
  assert.equal(reason(db, "duplicate_room_product_names").severity, "info");
  assert.equal(db.required, false);
  assert.equal(db.capacityUncertain, false);
});

test("repeated dates, distinct room tiers and generic type names do not create false duplicate warnings", () => {
  for (const rows of [
    [row(), row({ date: "2026-09-29" })],
    [row(), row({ bizItemId: "replaced", date: "2026-09-29", name: "[연박특가] 글램핑 A1동" })],
    [row({ name: "프리미엄 글램핑 1" }), row({ bizItemId: "normal", name: "글램핑 1" })],
    [row({ name: "스위트" }), row({ bizItemId: "night2", name: "[연박특가] 스위트" })],
    [row(), row({ bizItemId: "day", saleType: "데이유즈" })]
  ]) assert.equal(reason(reviewOf(item({ weeklyProductDetails: rows })), "duplicate_room_product_names"), undefined);
});

test("mixed facilities are reported by distinct product, not repeated product dates", () => {
  const source = item({ weeklyProductDetails: [row(), row({ bizItemId: "p", name: "펜션 101호" }), row({ bizItemId: "b", name: "방갈로 1" }), row({ bizItemId: "c", name: "캠핑A-1" }), row({ bizItemId: "p", name: "펜션 101호", date: "2026-09-29" })] });
  const mixed = reason(reviewOf(source), "glamping_mixed_facility_types");
  assert.deepEqual(mixed.evidence.productCountsByFacility, { glamping: 1, pension: 1, bungalow: 1, campsite: 1 });
  assert.equal(mixed.severity, "warning");
  const db = reviewOf({ ...source, inventoryCapacityBaseline: { lodgingOverride: { count: 4 } } });
  assert.equal(reason(db, "glamping_mixed_facility_types").severity, "info");
  assert.equal(db.capacityUncertain, false);
  const hotel = reviewOf({ ...source, name: "호텔", keyword: "호텔" });
  assert.equal(reason(hotel, "glamping_mixed_facility_types"), undefined);
});

test("query limits and incomplete product lists have explicit causes independent of collection partial", () => {
  const collectionProductCoverage = { businessId: "biz1", eligible: 62, queried: 40, truncated: 22, productListComplete: false, expectedDays: 1,
    days: [{ date: "2026-09-28", eligible: 62, queried: 40, truncated: 22 }] };
  const source = item({ collectionProductCoverage });
  const review = reviewOf(source);
  assert.equal(reason(review, "product_targets_truncated").evidence.omittedProducts, 22);
  assert.ok(reason(review, "product_list_incomplete"));
  assert.equal(reason(review, "product_day_targets_incomplete"), undefined, "known truncated products are not counted as unexplained missing requests again");
  const db = reviewOf({ ...source, inventoryCapacityBaseline: { lodgingOverride: { count: 31 } } });
  assert.equal(db.required, false);
  assert.equal(db.capacityUncertain, false);
  assert.equal(reason(db, "product_targets_truncated").severity, "info");
  assert.equal(reviewOf(item({ collectionProductCoverage: { ...collectionProductCoverage, businessId: "other" } })).required, false);
});

test("unattempted product days and absent expected dates are distinct from capped products", () => {
  const review = reviewOf(item({ collectionProductCoverage: { businessId: "biz1", eligible: 3, queried: 3, truncated: 0, expectedDays: 3,
    days: [{ date: "2026-09-28", eligible: 3, queried: 2, truncated: 0 }, { date: "2026-09-29", eligible: 3, queried: 3, truncated: 0 }] } }));
  assert.deepEqual(reason(review, "product_day_targets_incomplete").evidence, { incompleteDays: 1, absentDays: 1, dates: ["2026-09-28"] });
  assert.equal(reason(review, "product_targets_truncated"), undefined);
});

test("normal zero is distinguished from error zero without changing inventory inference", () => {
  const normal = reviewOf(item({ weeklyProductDetails: [row({ stock: 0 })] }));
  assert.ok(reason(normal, "zero_stock_capacity_unverified"));
  assert.equal(reason(normal, "stock_collection_failed"), undefined);
  assert.equal(reason(normal, "stock_evidence_missing"), undefined);
  const failed = reviewOf(item({ weeklyProductDetails: [row({ stock: 0, collectionFailed: true })] }));
  assert.ok(reason(failed, "stock_collection_failed"));
  assert.equal(reason(failed, "zero_stock_capacity_unverified"), undefined);
  assert.equal(reason(failed, "stock_evidence_missing"), undefined, "recorded failures are not reported as absent rows");
  assert.equal(failed.capacityUncertain, true);
  const db = reviewOf(item({ inventoryCapacityBaseline: { lodgingOverride: { count: 16 } }, weeklyProductDetails: [row({ stock: 0, collectionFailed: true })] }));
  assert.equal(db.capacityUncertain, false);
  assert.equal(reason(db, "stock_collection_failed").severity, "info");
});

test("a complete valid date keeps isolated failures and gaps as observation notes", () => {
  const result = applyInventoryEvidence(item({ bookingRangeDays: 3, checkIn: "2026-09-28", weeklyProductDetails: [row({ stock: 10 }), row({ date: "2026-09-29", stock: 0, collectionFailed: true })] }));
  const review = result.inventoryEvidence.capacityReview;
  assert.equal(result.totalRooms, 10);
  assert.equal(review.required, false);
  assert.equal(review.capacityUncertain, false);
  assert.equal(reason(review, "stock_collection_failed").severity, "info");
  assert.equal(reason(review, "stock_evidence_missing").evidence.missingDays, 1);
  assert.equal(result.inventoryEvidence.lodging.status, "partial", "collection completeness remains independently meaningful");
});

test("unobserved stock placeholders cannot become reliable evidence in the warning read model", () => {
  for (const extra of [{ stockObserved: false }, { missing: true }, { queryAttempted: false }, { stock: null }, { stock: " " }]) {
    const source = item({ weeklyProductDetails: [row(extra)] });
    const before = JSON.stringify(source), review = buildCapacityReview(source);
    assert.equal(review.capacityUncertain, true);
    assert.ok(reason(review, "stock_evidence_missing"));
    assert.equal(JSON.stringify(source), before);
  }
});

test("DB observation conflicts preserve the reviewed total without labeling it uncertain", () => {
  const source = item({ inventoryCapacityBaseline: { lodgingOverride: { count: 16 } }, weeklyProductDetails: [row({ stock: 17, bookingCount: 1 })] });
  const result = applyInventoryEvidence(source), review = result.inventoryEvidence.capacityReview;
  assert.equal(result.totalRooms, 16);
  assert.equal(review.required, true);
  assert.equal(review.capacityUncertain, false);
  assert.equal(reason(review, "db_capacity_observation_conflict").scope, "observation");
  assert.equal(result.weeklyPhoneBookings, 0);
  assert.equal(result.weeklyPublicBookings, 1);
});

test("an exact owner stock correction resolves the warning while retaining original seven-room evidence", () => {
  const source = item({ inventoryCapacityBaseline: { lodgingOverride: { count: 6 }, productStockCorrections: [{ bizItemId: "room1", stayDate: "2026-09-28", observedStock: 7, correctedStock: 6, reason: "업주 확인" }] }, weeklyProductDetails: [row({ stock: 7 })] });
  const result = applyInventoryEvidence(source);
  assert.equal(result.totalRooms, 6);
  assert.equal(result.weeklyProductDetails[0].stock, 7);
  assert.equal(result.inventoryEvidence.capacityReview.required, false);
  assert.equal(buildCapacityReview(source).required, false);
});

test("legacy grades alone do not create a warning and missing raw stock is explicit", () => {
  const healthy = item({ inventoryConfidenceGrade: "E", inventoryConfidenceScore: 1 });
  assert.equal(reviewOf(healthy).required, false);
  const legacy = { name: "예전 숙소", totalRooms: 16, weeklyProductDetails: [{ date: "2026-09-28", total: 16, available: 8 }] };
  const before = JSON.stringify(legacy), review = buildCapacityReview(legacy);
  assert.equal(review.capacityUncertain, true);
  assert.ok(reason(review, "stock_evidence_missing"));
  assert.equal(applyInventoryEvidence(legacy), legacy, "legacy arithmetic and API evidence shape are untouched");
  assert.equal(JSON.stringify(legacy), before);
  const reviewedLegacy = buildCapacityReview({ ...legacy, inventoryCapacityBaseline: { lodgingOverride: { count: 16 } } });
  assert.equal(reviewedLegacy.reviewed, true);
  assert.equal(reviewedLegacy.required, false);
});

test("range stock requires review but normal type-stock and day-use-only inputs do not", () => {
  assert.ok(reason(reviewOf(item({ listType: "묶음 예약리스트", groupedRoomCount: 4 })), "grouped_room_stock_unverified"));
  assert.equal(reviewOf(item({ listType: "객실 종류별 예약리스트" })).required, false);
  assert.equal(reviewOf(item({ weeklyProductDetails: [row({ saleType: "데이유즈" })] })).required, false);
});

test("clearing a DB correction cannot retain the previous reviewed state", () => {
  const first = applyInventoryEvidence(item({ inventoryCapacityBaseline: { lodgingOverride: { count: 45 } }, weeklyProductDetails: [row({ stock: 45 })] }));
  const cleared = applyInventoryEvidence({ ...first, inventoryCapacityBaseline: { lodging: 45 } });
  assert.equal(cleared.inventoryEvidence.capacityReview.reviewed, false);
  assert.equal(cleared.inventoryEvidence.capacityReview.capacityUncertain, true);
  assert.equal(cleared.totalRooms, 45);
});

const storedSnapshot = () => ({ inventoryEvidenceVersion: 4, runId: "stored_run", capacityBasis: { count: 2, source: "observed_maximum", observedMaximum: 2, currentObservedMaximum: 2 },
  capacityReview: { required: false, codes: [] }, summary: { productCount: 2, observedProductCount: 2, confirmedEstimatedRevenue: 100000 },
  products: [
    { bizItemId: "room1", name: "글램핑 A1동", productType: "lodging", total: 100, latestTotal: 0, priceByDate: [{ date: "2026-09-28", price: 100000 }] },
    { bizItemId: "multi", name: "[연박특가] 글램핑 A1동", productType: "lodging", total: 100, latestTotal: 0, priceByDate: [{ date: "2026-09-28", price: 90000 }] }
  ], daily: [{ date: "2026-09-28", productType: "lodging", rawTotal: 2, total: 2, available: 1, publicBookings: 1, phoneBookings: 0, sold: 1, estimatedRevenue: 100000, partial: false, missing: false }] });

test("stored legacy review gains duplicate warnings without fabricating stock observations or changing financial values", () => {
  const snapshot = storedSnapshot(), before = JSON.stringify(snapshot);
  const review = buildStoredCapacityReview(snapshot, { name: "검수 글램핑", baseline: { lodging: 2 } });
  assert.equal(review.version, 2);
  assert.equal(review.source, "stored_snapshot");
  assert.ok(reason(review, "duplicate_room_product_names"));
  assert.equal(reason(review, "glamping_observed_over_40"), undefined, "stored per-product maxima cannot establish a same-date company total");
  assert.equal(reason(review, "zero_stock_capacity_unverified"), undefined, "zero product summaries have lost failure flags and cannot be declared healthy zeros");
  assert.equal(reason(review, "stock_evidence_missing"), undefined);
  assert.equal(JSON.stringify(snapshot), before);
});

test("stored review responds immediately to current DB correction, conflict and clear without mutating snapshots", () => {
  const snapshot = storedSnapshot();
  snapshot.capacityBasis = { ...snapshot.capacityBasis, source: "db_correction", count: 50 };
  snapshot.daily[0].capacityConflict = true;
  const reviewed = buildStoredCapacityReview(snapshot, { baseline: { lodging: 2, lodgingOverride: 2 } });
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.required, false, "an obsolete stored conflict is recomputed from current count");
  assert.equal(reviewed.capacityUncertain, false);
  const conflict = buildStoredCapacityReview(snapshot, { baseline: { lodging: 2, lodgingOverride: 1 } });
  assert.equal(reason(conflict, "db_capacity_observation_conflict").scope, "observation");
  assert.equal(conflict.capacityUncertain, false);
  const cleared = buildStoredCapacityReview(snapshot, { baseline: { lodging: 2, lodgingOverride: null } });
  assert.equal(cleared.reviewed, false);
  assert.equal(cleared.capacityUncertain, true);
  assert.equal(reason(cleared, "db_capacity_observation_conflict"), undefined);
});

test("stored coverage facts persist while missing error provenance is not invented", () => {
  const snapshot = storedSnapshot();
  snapshot.capacityReview = { version: 2, reasons: [{ code: "product_targets_truncated", severity: "warning", scope: "capacity", message: "22개 상품 미조회", evidence: { omittedProducts: 22 } }] };
  snapshot.daily[0].missing = true;
  snapshot.daily[0].partial = true;
  snapshot.daily[0].rawTotal = 0;
  const review = buildStoredCapacityReview(snapshot, { baseline: { lodging: 2, lodgingOverride: 31 } });
  assert.equal(reason(review, "product_targets_truncated").evidence.omittedProducts, 22);
  assert.equal(reason(review, "product_targets_truncated").severity, "info");
  assert.equal(reason(review, "stock_evidence_missing").severity, "info");
  assert.equal(reason(review, "stock_collection_failed"), undefined);
  assert.equal(reason(review, "zero_stock_capacity_unverified"), undefined);
  assert.equal(review.capacityUncertain, false);
});

test("existing recalculation unavailable caveat stays visible as an observation warning", () => {
  const snapshot = { ...storedSnapshot(), recalculationUnavailable: true, capacityReview: { required: true, codes: ["correction_recalculation_unavailable"] } };
  const review = buildStoredCapacityReview(snapshot, { baseline: { lodging: 2, lodgingOverride: 2 } });
  assert.equal(reason(review, "correction_recalculation_unavailable").severity, "warning");
  assert.equal(reason(review, "correction_recalculation_unavailable").scope, "observation");
  assert.equal(review.capacityUncertain, false);
});

test("real company summary functions attach the current read-only review and preserve all stored totals", () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const context = vm.createContext({ buildStoredCapacityReview, companyMaximumRoomCapacity: () => 2,
    manualCorrectionLodgingBasisTotal: (value) => value?.active !== false && value?.lodgingBasisTotal || null });
  for (const name of ["companySnapshotCapacityReview", "companyProductSnapshotSummary", "companyInventorySummaryView"]) {
    const start = source.indexOf(`function ${name}(`), tail = source.slice(start + 1), end = /\n(?:async )?function /.exec(tail);
    assert.ok(start >= 0 && end);
    vm.runInContext(source.slice(start, start + 1 + end.index), context);
  }
  const snapshot = storedSnapshot(), inventory = { latest: { runId: snapshot.runId, revenue: { lodging: { revenue: 100000 } }, productSnapshot: snapshot } };
  const before = JSON.stringify(inventory);
  const summary = context.companyInventorySummaryView(inventory, { primaryName: "검수 글램핑", keywords: {} });
  assert.equal(summary.latest.productSnapshot.capacityReview.version, 2);
  assert.equal(summary.latest.productSnapshot.capacityReview.capacityUncertain, true);
  assert.equal(summary.latest.revenue.lodging.revenue, 100000);
  assert.equal(summary.latest.productSnapshot.summary.confirmedEstimatedRevenue, 100000);
  const corrected = context.companyInventorySummaryView(inventory, { primaryName: "검수 글램핑", keywords: {}, manualCorrection: { lodgingBasisTotal: 2 } });
  assert.equal(corrected.latest.capacityReview.reviewed, true);
  assert.equal(corrected.latest.capacityReview.capacityUncertain, false);
  assert.equal(JSON.stringify(inventory), before, "no summary, snapshot, daily count, or revenue data was mutated");
  assert.match(source, /capacityReview: companySnapshotCapacityReview\(dailySnapshot/, "detail GET uses the same current read-model review");
});
