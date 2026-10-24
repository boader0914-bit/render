"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { test } = require("node:test");
const inventory = require("./inventory_estimation.cjs");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n?/g, "\n");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n}", start);
  assert.ok(end >= 0, `${name} has its top-level closing brace`);
  return source.slice(start, end + 2);
}

function projectionContext() {
  // No application import, listener, source-file reads or synthetic replacement
  // for matching/capacity/evidence/confidence. Unrelated regional metadata and
  // legacy text parsing are identical stubs in the two compared projections.
  const context = vm.createContext({
    B2B_INTEREST_LODGE_SEGMENT_LIMIT: 12,
    applyInventoryEvidence: inventory.applyInventoryEvidence,
    buildCapacityReview: inventory.buildCapacityReview,
    collectionCapacityCoverageForBusiness: require("./lib/collection_capacity_coverage.cjs").collectionCapacityCoverageForBusiness,
    sanitizeMemberText: (value, max) => String(value || "").trim().slice(0, max),
    boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit),
    parseWeeklyReservationRates: () => ({}), parseStockVarianceDetail: () => ({}),
    resolvedStockBasis: () => ({}), offlineReservedTotalForOperating: () => 0,
    naverChannelObservationFromItem: () => ({}),
    rowSearchRegion: () => "", rowAddressRegion: () => "", regionBoundaryInfo: () => ({}),
    naverCouponSignalFromItem: () => ({ named: false }),
    compactKeyword: value => String(value || "").replace(/\s+/g, "")
  });
  const names = [
    "extractNaverPlaceId", "extractBookingBusinessId", "companyProductAvailabilityMatch",
    "productSnapshotNumber", "companyMaximumRoomCapacity", "withCompanyInventoryCapacityRecord",
    "withCompanyInventoryCapacity", "createCompanyInventoryCapacityIndex", "withIndexedCompanyInventoryCapacity",
    "manualCorrectionLodgingBasisTotal", "manualCorrectionRoomSegmentTotal", "manualCorrectionRoomSegments",
    "sanitizeManualCorrectionRoomSegments", "sanitizeB2BInterestLodgeSegment", "b2bInterestLodgeSegmentHasInput",
    "sanitizeInterestLodgeNumberText", "sanitizeManualCorrectionMeta", "manualCorrectionHasValue",
    "manualCorrectionHasBasis", "manualCorrectionMetaHasValue", "maxPositiveNumber", "parseBasisTotalFromRule", "stockBasisRule",
    "numericField", "jsonArrayField", "availabilityPlaceKey", "availabilityBookingBusinessId", "normalizeInventoryMemo",
    "inventoryConfidenceLabel", "inventoryStructureMeta", "evaluateInventoryStructure", "evaluateInventoryConfidence",
    "summarizeAvailabilityRows"
  ];
  for (const name of names) vm.runInContext(functionSource(name), context);
  const legacy = functionSource("summarizeAvailabilityRows")
    .replace("function summarizeAvailabilityRows(", "function summarizeAvailabilityRowsLegacy(")
    .replace("  const capacityIndex = availabilityItems.length ? createCompanyInventoryCapacityIndex(capacityCompanies) : null;\n", "")
    .replace("applyInventoryEvidence(withIndexedCompanyInventoryCapacity({", "applyInventoryEvidence(withCompanyInventoryCapacity({")
    .replace("}, capacityIndex)))", "}, capacityCompanies)))");
  assert.ok(!legacy.includes("capacityIndex"), "legacy reference uses the original full-array matcher");
  vm.runInContext(legacy, context);
  return context;
}

function company(companyId, placeIds = [], bookingBusinessIds = []) {
  return { companyId, placeIds, bookingBusinessIds, lodgingTypes: ["글램핑"],
    inventory: { latest: { productSnapshot: { inventoryEvidenceVersion: 4,
      capacityBasis: { currentObservedMaximum: 16, observedMaximum: 99 } } } } };
}
const json = value => JSON.parse(JSON.stringify(value));

test("provider index keeps original exact-id, ambiguity and item-reference contracts", () => {
  const c = projectionContext();
  const a = company("a", ["100"], ["200"]), b = company("b", ["101"], ["201"]);
  const sameId = company("a", ["100"], ["200"]);
  const matrix = [
    ["unique place", [a, b], { placeId: "100" }, "a"],
    ["unique booking", [a, b], { bookingBusinessId: "200" }, "a"],
    ["both consistent", [a, b], { placeId: "100", bookingBusinessId: "200" }, "a"],
    ["opposite id conflict", [a, b], { placeId: "100", bookingBusinessId: "201" }, null],
    ["booking without stored place", [company("only-booking", [], ["200"]), b], { placeId: "999", bookingBusinessId: "200" }, "only-booking"],
    ["place without stored booking", [company("only-place", ["100"], []), b], { placeId: "100", bookingBusinessId: "999" }, "only-place"],
    ["union must not intersect", [a, company("booking", [], ["201"])], { placeId: "100", bookingBusinessId: "201" }, "booking"],
    ["duplicate place", [a, company("other", ["100"])], { placeId: "100" }, null],
    ["duplicate booking", [a, company("other", [], ["200"])], { bookingBusinessId: "200" }, null],
    ["same object twice", [a, a], { placeId: "100" }, null],
    ["same company id still distinct", [a, sameId], { placeId: "100" }, null],
    ["repeated ids within one position", [company("a", ["100", "100", 100], ["200", "200"])], { placeId: "100", bookingBusinessId: "200" }, "a"],
    ["normalized numbers and whitespace", [company("a", [100, " 100 ", false, 0], [" 200 "])], { placeId: " 100 ", bookingBusinessId: 200 }, "a"],
    ["URL ids", [a], { url: "https://x/accommodation/100", naverBookingUrl: "https://x/bizes/200" }, "a"],
    ["explicit id wins over URL", [a], { placeId: "101", url: "https://x/accommodation/100" }, null],
    ["false explicit id falls back", [a], { placeId: false, url: "https://x/accommodation/100" }, "a"],
    ["no provider id/name is insufficient", [a], { name: "same name", address: "same address" }, null],
    ["inactive company retained", [{ ...a, active: false, deleted: true, mergedInto: "b" }], { placeId: "100" }, "a"],
    ["explicit undefined uses matcher default", [undefined, a], { placeId: "100" }, "a"],
    ["empty array", [], { placeId: "100" }, null]
  ];
  for (const [label, companies, fields, expected] of matrix) {
    const item = { ...fields, extraUnknownField: { value: null }, inventoryCapacityBaseline: { lodgingOverride: { count: 99 } } };
    const before = JSON.stringify(item);
    const original = c.withCompanyInventoryCapacity(item, companies);
    const indexed = c.withIndexedCompanyInventoryCapacity(item, c.createCompanyInventoryCapacityIndex(companies));
    assert.deepEqual(json(indexed), json(original), label);
    assert.equal(indexed.inventoryCapacityBaseline?.companyId || null, expected, label);
    if (!expected) assert.equal(indexed, item, `${label}: no/ambiguous match retains original reference`);
    assert.equal(JSON.stringify(item), before, `${label}: input item unchanged`);
  }
});

test("array positions, sparse holes and candidate ordering remain unchanged", () => {
  const c = projectionContext();
  const a = company("a", ["100"], []), b = company("b", [], ["200"]);
  const companies = new Array(7);
  companies[1] = a; companies[5] = b;
  const index = c.createCompanyInventoryCapacityIndex(companies);
  const matcher = c.companyProductAvailabilityMatch;
  const seen = [];
  c.companyProductAvailabilityMatch = (value, item) => { seen.push(value.companyId); return matcher(value, item); };
  const item = { placeId: "100", bookingBusinessId: "200" };
  assert.equal(c.withIndexedCompanyInventoryCapacity(item, index), item);
  assert.deepEqual(seen, ["a", "b"], "union candidates follow original positions, not provider bucket order");
  companies[6] = a;
  assert.equal(c.withIndexedCompanyInventoryCapacity({ placeId: "100" }, c.createCompanyInventoryCapacityIndex(companies)).inventoryCapacityBaseline, undefined);
  const prototype = Object.create(Array.prototype);
  prototype[0] = a;
  const inherited = new Array(2);
  Object.setPrototypeOf(inherited, prototype);
  assert.deepEqual(json(c.withIndexedCompanyInventoryCapacity({ placeId: "100" }, c.createCompanyInventoryCapacityIndex(inherited))),
    json(c.withCompanyInventoryCapacity({ placeId: "100" }, inherited)), "inherited present array positions match filter semantics");
});

function observationRows() {
  return Array.from({ length: 20 }, (_, n) => ({ placeId: String(100 + n), place_id: String(100 + n),
    bookingBusinessId: String(200 + n), name: `fixture ${n}`, rank_or_order: 20 - n,
    availableRooms: 8, totalRooms: 16, "예약리스트유형": n % 2 ? "객실 종류별" : "객실별",
    dayUseMode: "inspect", dayUsePresence: n % 3 ? "unknown" : "absent", dayUseScheduleStatus: "not_requested",
    weeklyProductDetails: [
      { date: "2026-10-22", bizItemId: `room-${n}`, name: "숙박", stock: 16, bookingCount: 2, occupiedBookingCount: 3, price: n % 2 ? null : 120000 },
      { date: "2026-10-23", bizItemId: `room-${n}`, name: "숙박", stock: 0, open: false, bookingCount: 0, price: 0 },
      { date: "2026-10-24", bizItemId: `room-${n}`, name: "숙박", collectionFailed: true }
    ] }));
}

test("full summary preserves every stock, quality, manual correction and missingness field", () => {
  const c = projectionContext();
  const companies = Array.from({ length: 539 }, (_, n) => company(`c${n}`, [String(100 + n)], [String(200 + n)]));
  companies[0].manualCorrection = { active: true, lodgingBasisTotal: 10, dayUseBasisTotal: 3, updatedAt: "2026-10-22T00:00:00Z" };
  companies[1].manualCorrection = { active: false, lodgingBasisTotal: 3 };
  companies[2].manualCorrection = { active: true, productStockCorrections: [{ bizItemId: "room-2", stayDate: "2026-10-22",
    observedStock: 16, correctedStock: 9, reason: "fixture reviewed stock" }] };
  companies[3].lodgingTypes = ["캠핑"];
  const rows = observationRows();
  const before = JSON.stringify({ rows, companies });
  const range = { keyword: "fixture", checkIn: "2026-10-22", bookingRangeDays: 3 };
  const matcher = c.companyProductAvailabilityMatch;
  let calls = 0;
  c.companyProductAvailabilityMatch = (value, item) => { calls++; return matcher(value, item); };
  const legacy = c.summarizeAvailabilityRowsLegacy(rows, "", companies, range);
  const legacyCalls = calls; calls = 0;
  const indexed = c.summarizeAvailabilityRows(rows, "", companies, range);
  assert.deepEqual(json(indexed), json(legacy), "complete JSON result, not selected metric fields");
  assert.equal(legacyCalls, 539 * 20);
  assert.equal(calls, 20, "one unchanged final identity check per unique matching candidate");
  assert.equal(JSON.stringify({ rows, companies }), before, "all source rows and company records unchanged");
  assert.equal(indexed.items.length, 20);
  assert.ok(indexed.items.every(item => item.inventoryConfidenceGrade && item.inventoryStructure && item.inventoryEvidence));
  assert.equal(indexed.stats.dayUseEstimatedRevenue, null, "unobserved day-use is still unknown");
  assert.deepEqual(json(indexed.items.map(item => item.rank)), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("each summary rebuilds its private index after company mutations", () => {
  const c = projectionContext();
  const companies = [company("a", ["100"], ["200"])];
  const rows = observationRows().slice(0, 1);
  const first = c.summarizeAvailabilityRows(rows, "", companies);
  assert.equal(first.items[0].inventoryCapacityBaseline.companyId, "a");
  companies[0].placeIds = ["999"]; companies[0].bookingBusinessIds = ["999"];
  const second = c.summarizeAvailabilityRows(rows, "", companies);
  assert.equal(second.items[0].inventoryCapacityBaseline, undefined);
  companies.push(company("new", ["100"], ["200"]));
  const third = c.summarizeAvailabilityRows(rows, "", companies);
  assert.equal(third.items[0].inventoryCapacityBaseline.companyId, "new");
});

test("empty or wholly invalid source rows do not inspect capacity companies", () => {
  const c = projectionContext();
  for (const rows of [[], [{ name: "no observed inventory" }], [{ availableRooms: 0, totalRooms: 0 }]]) {
    assert.deepEqual(json(c.summarizeAvailabilityRows(rows, "", [null])), json(c.summarizeAvailabilityRowsLegacy(rows, "", [null])));
  }
  for (const companies of [[null], [{ placeIds: "invalid" }], [{ bookingBusinessIds: "invalid" }]]) {
    const item = { placeId: "100" };
    assert.throws(() => c.withCompanyInventoryCapacity(item, companies), { name: "TypeError" });
    assert.throws(() => c.createCompanyInventoryCapacityIndex(companies), { name: "TypeError" });
  }
});

test("calculation fingerprint binds index, summary and unchanged transitive matching helpers", () => {
  const fingerprint = functionSource("companyIntegratedCalculationFingerprint");
  const callbackList = fingerprint.match(/const callbacks = \[([\s\S]*?)\];/)[1];
  const names = callbackList.match(/\b[A-Za-z_$][\w$]*\b/g);
  const context = vm.createContext({ crypto });
  for (const name of names) vm.runInContext(`function ${name}() {}`, context);
  const targets = ["createCompanyInventoryCapacityIndex", "withIndexedCompanyInventoryCapacity", "summarizeAvailabilityRows",
    "withCompanyInventoryCapacity", "withCompanyInventoryCapacityRecord", "companyProductAvailabilityMatch", "extractNaverPlaceId", "extractBookingBusinessId"];
  for (const name of targets) {
    assert.ok(names.includes(name), `${name} is explicitly version bound`);
    vm.runInContext(functionSource(name), context);
  }
  vm.runInContext(fingerprint, context);
  const baseline = context.companyIntegratedCalculationFingerprint();
  for (const name of targets) {
    const original = context[name];
    vm.runInContext(functionSource(name).replace("{", "{ /* dependency changed */"), context);
    assert.notEqual(context.companyIntegratedCalculationFingerprint(), baseline, `${name} body changes source version`);
    context[name] = original;
    assert.equal(context.companyIntegratedCalculationFingerprint(), baseline);
  }
});
