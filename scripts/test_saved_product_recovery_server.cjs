"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createSavedProductRecovery } = require("./lib/saved_product_recovery.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");

// Use the real server's quantity/correction/history functions, without starting
// its listener or reading a production company, result, or credential file.
const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const context = vm.createContext({
  B2B_INTEREST_LODGE_SEGMENT_LIMIT: 12,
  applyInventoryEvidence: require("./inventory_estimation.cjs").applyInventoryEvidence,
  crypto,
  sanitizeMemberText: (value, limit) => String(value || "").trim().slice(0, limit),
  boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit),
  compactKeyword: value => String(value || "").replace(/\s+/g, ""),
  kstDayKeyFromValue: value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10),
  runCollectionDbRoute: () => ({ key: "test_saved_evidence", label: "test" }),
  normalizeCollectionPurpose: () => "revenue_detail",
  COLLECTION_PURPOSES: { revenue_detail: "상세정보 수집" }
});
for (const name of [
  "productSnapshotNumber", "companyMaximumRoomCapacity", "withCompanyInventoryCapacityRecord", "applyCompanyManualCorrection",
  "manualCorrectionLodgingBasisTotal", "manualCorrectionRoomSegmentTotal", "manualCorrectionRoomSegments",
  "sanitizeManualCorrectionRoomSegments", "sanitizeB2BInterestLodgeSegment", "b2bInterestLodgeSegmentHasInput",
  "sanitizeInterestLodgeNumberText", "sanitizeManualCorrectionMeta", "manualCorrectionHasValue", "manualCorrectionHasBasis",
  "manualCorrectionMetaHasValue", "maxPositiveNumber", "inventoryEstimateBreakdown", "historySeriesForItem",
  "buildHistoryObservations", "dateDiffDays", "stableHash"
]) {
  const asyncStart = serverSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : serverSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is the current server function`);
  const next = /\n(?:async )?function /.exec(serverSource.slice(start + 1));
  vm.runInContext(serverSource.slice(start, next ? start + 1 + next.index : serverSource.length), context);
}
const copy = value => JSON.parse(JSON.stringify(value));
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const RUN_ID = "gyeongnam_glamping_20260901_090000";
const COMPANY_ID = "cmp_place_1104404759";
const REQUEST = { type: "company", targetId: COMPANY_ID, month: "2026-09", cutoffDate: "2026-09-30" };
function product(date, id, stock, bookings, occupied = 0, extras = {}) {
  return { date, key: `id:${id}`, bizItemId: id, name: `숙박 ${id}`, saleType: "숙박", bizItemSubType: "ACCOMMODATION_NIGHT",
    listType: "객실 종류별 리스트", availabilityUnit: "재고수량", total: stock,
    available: stock - bookings - occupied, soldOut: bookings + occupied,
    stock, bookingCount: bookings, occupiedBookingCount: occupied, price: 100000, open: true, ...extras };
}
function csv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [columns.map(cell).join(","), ...rows.map(row => columns.map(key => cell(row[key])).join(","))].join("\r\n") + "\r\n";
}
async function fixture(t, { products, days = 2, nightCount = 2, dayCount = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "saved-product-server-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("saved-product-server-"));
    await fsp.rm(root, { recursive: true, force: true });
  });
  const runDirectory = path.join(root, "outputs", RUN_ID);
  await fsp.mkdir(path.join(runDirectory, "details"), { recursive: true });
  const detailsName = "details/1104404759_weekly_product_details_fixture.json";
  const entries = products || [product("2026-09-01", "room_a", 5, 0), product("2026-09-01", "room_b", 5, 0),
    product("2026-09-02", "room_a", 5, 2, 2), product("2026-09-02", "room_b", 5, 1)];
  const manifest = { runId: RUN_ID, keyword: "경남글램핑", collectedAt: "2026-09-01T00:10:00.000Z", checkIn: "2026-09-01",
    checkOut: "2026-09-02", bookingRangeDays: days, collectionPurpose: "revenue_detail", collectionQuality: null,
    fileRoles: { overall: "경남글램핑_네이버전체순위.csv" }, detailJsonFiles: [{ field: "weekly_product_details", name: "시즌글램핑",
      placeId: "1104404759", bookingBusinessId: "1040638", file: detailsName, itemCount: entries.length }] };
  const row = { place_id: "1104404759", bookingBusinessId: "1040638", "업체명": "시즌글램핑", overall_rank: 1,
    "네이버예약URL": "https://booking.naver.com/booking/3/bizes/1040638", "숙박상품수": nightCount, "데이유즈상품수": dayCount,
    "예약계산대상상품수": nightCount, "네이버요일별상품상세JSON": `@json-file:${detailsName}` };
  const company = { companyId: COMPANY_ID, primaryName: "시즌글램핑", placeIds: ["1104404759"], bookingBusinessIds: ["1040638"],
    runIds: [RUN_ID], manualCorrection: { active: true, lodgingBasisTotal: 10 } };
  const other = { companyId: "cmp_place_999", primaryName: "동명 업체", placeIds: ["999"], bookingBusinessIds: ["888"], runIds: [RUN_ID] };
  const data = { rawCompanies: new Map([[COMPANY_ID, company], [other.companyId, other]]),
    companies: [{ ...company, regionKey: "sancheong", capacity: 10, capacitySource: "db_review" }, { ...other, regionKey: "other" }],
    runs: [{ id: RUN_ID, ...manifest, collectedAtSource: "recorded" }], observations: [] };
  const write = async () => {
    await fsp.writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(manifest));
    await fsp.writeFile(path.join(runDirectory, manifest.fileRoles.overall), csv([row]));
    await fsp.writeFile(path.join(runDirectory, detailsName), JSON.stringify(entries));
  };
  await write();
  const dependencies = { dataDir: root, projectCompany: copy, applyCompanyManualCorrection: context.applyCompanyManualCorrection,
    buildHistoryObservations: context.buildHistoryObservations, now: () => new Date("2026-10-24T00:00:00.000Z") };
  return { root, runDirectory, manifest, row, entries, company, data, write, dependencies, service: createSavedProductRecovery(dependencies) };
}
async function recoverAndRead(f) {
  const recovery = await f.service.recover({ month: "2026-09", companyIds: [COMPANY_ID] }, f.data);
  return { recovery, ...await f.service.read(REQUEST, f.data) };
}
function snapshot(f, recovered, extra = {}) {
  return buildMonthlyReportSnapshot(REQUEST, { ...f.data, savedProductRecoveries: recovered.observations, ...extra }, "2026-10-24T00:00:00.000Z");
}

test("real server corrections and history recover only certified legacy company dates, including a normal zero", async t => {
  const f = await fixture(t);
  const sourceBefore = {};
  for (const name of ["manifest.json", f.manifest.fileRoles.overall, f.manifest.detailJsonFiles[0].file])
    sourceBefore[name] = sha(await fsp.readFile(path.join(f.runDirectory, name)));
  const masterBefore = JSON.stringify([...f.data.rawCompanies]);
  const result = await recoverAndRead(f);
  assert.equal(result.recovery.receipts.length, 1, JSON.stringify(result.recovery.warnings));
  assert.equal(result.observations.length, 2);
  const first = result.observations.find(value => value.row.stayDate === "2026-09-01").row;
  const second = result.observations.find(value => value.row.stayDate === "2026-09-02").row;
  assert.equal(first.sold, 0); assert.equal(first.estimatedRevenue, 0);
  assert.equal(second.supply, 10); assert.equal(second.publicBookings, 3); assert.equal(second.phoneBookings, 2);
  assert.equal(second.estimatedRevenue, 500000);
  assert.equal(first.collectedAt, f.manifest.collectedAt);
  const report = snapshot(f, result);
  assert.equal(report.summary.lodging.coveredCompanyDays, 2);
  assert.equal(report.summary.lodging.sold, 5);
  assert.equal(report.summary.lodging.estimatedRevenue, 500000);
  assert.equal(f.data.runs[0].collectionQuality, null, "the legacy run is never globally upgraded");
  assert.equal(JSON.stringify([...f.data.rawCompanies]), masterBefore);
  for (const [name, digest] of Object.entries(sourceBefore)) assert.equal(sha(await fsp.readFile(path.join(f.runDirectory, name))), digest);
  const afterRestart = await createSavedProductRecovery(f.dependencies).read(REQUEST, f.data);
  assert.deepEqual(copy(afterRestart), copy({ observations: result.observations, warnings: result.warnings,
    productCapacityEvidence: result.productCapacityEvidence }));
  assert.equal(afterRestart.productCapacityEvidence.length, 2);
  assert.ok(afterRestart.productCapacityEvidence.every(value => value.companyId === COMPANY_ID && value.runId === RUN_ID && value.count === 5));
  assert.equal((await f.service.recover({ month: "2026-09", companyIds: [COMPANY_ID] }, f.data)).receipts[0].created, false);
});

test("putting recovery-looking markers on raw observations does not bypass unknown legacy run quality", async t => {
  const f = await fixture(t), result = await recoverAndRead(f);
  const raw = result.observations.map(value => ({ ...value.row, savedProductRecovery: value.certificate, recoveryCertificate: value.certificate }));
  const report = snapshot(f, { observations: [] }, { observations: raw });
  assert.equal(report.summary.lodging.coveredCompanyDays, 0);
  assert.equal(report.quality.discardedByReason.unknown_legacy_run_quality, 2);
  const changed = copy(result);
  changed.observations[0].row.sold = 1;
  changed.observations[0].row.publicBookings = 1;
  assert.equal(snapshot(f, changed).summary.lodging.coveredCompanyDays, 1, "a changed row cannot reuse a certificate for a normal zero");
});

test("source hash changes invalidate a saved recovery instead of silently reusing a certified row", async t => {
  const f = await fixture(t); await recoverAndRead(f);
  f.entries[0].bookingCount = 1; f.entries[0].available = 4;
  await f.write();
  await assert.rejects(() => f.service.read(REQUEST, f.data), error => error.code === "RECOVERY_SOURCE_CHANGED" && error.statusCode === 503,
    "a failed refresh must preserve the last valid aggregate rather than publish an empty replacement");
});

test("an excluded failure cannot supply another day's fallback price or raise the room basis", async t => {
  const products = [product("2026-09-01", "room_a", 0, 0, 0, { price: null }),
    product("2026-09-02", "room_a", 99, 0, 0, { price: 900000, errors: ["schedule_request_failed"] })];
  const f = await fixture(t, { products, nightCount: 1 });
  const result = await recoverAndRead(f);
  assert.equal(result.observations.length, 1, JSON.stringify(result.recovery.warnings));
  const row = result.observations[0].row;
  assert.equal(row.stayDate, "2026-09-01");
  assert.equal(row.supply, 10, "the reviewed room total stays fixed");
  assert.equal(row.phoneRevenue, 0, "an excluded response supplies no price evidence");
  assert.equal(row.phoneMissingPriceBookings, 10);
  assert.deepEqual(copy(row.phonePriceEstimates), []);
  const report = snapshot(f, result);
  assert.equal(report.summary.lodging.coveredCompanyDays, 1);
  assert.equal(report.summary.lodging.estimatedRevenue, null, "missing money remains unknown, never a confirmed zero");
});

test("real shared-day-use evidence is subtracted from lodging blocks without erasing public lodging reservations", async t => {
  const products = [product("2026-09-01", "room_a", 10, 1, 3),
    product("2026-09-01", "day_a", 2, 2, 0, { name: "데이유즈", saleType: "데이유즈", bizItemSubType: "DAY_USE", price: 50000 })];
  const f = await fixture(t, { products, days: 1, nightCount: 1, dayCount: 1 });
  const result = await recoverAndRead(f);
  assert.equal(result.observations.length, 2);
  const lodging = result.observations.find(value => value.row.productType === "lodging").row;
  const dayUse = result.observations.find(value => value.row.productType === "dayuse").row;
  assert.equal(lodging.supply, 10); assert.equal(lodging.publicBookings, 1);
  assert.equal(lodging.sharedDayUseExcluded, 2); assert.equal(lodging.phoneBookings, 1); assert.equal(lodging.sold, 2);
  assert.equal(lodging.estimatedRevenue, 200000); assert.equal(dayUse.sold, 2); assert.equal(dayUse.estimatedRevenue, 100000);
  const report = snapshot(f, result);
  assert.equal(report.summary.lodging.estimatedRevenue, 200000);
  assert.equal(report.summary.dayuse.estimatedRevenue, 100000);
});

test("a missing day-use product date cannot become a complete lodging observation", async t => {
  const products = [product("2026-09-01", "room_a", 10, 1, 1),
    product("2026-09-01", "day_a", 2, 1, 0, { name: "데이유즈", saleType: "데이유즈", bizItemSubType: "DAY_USE", price: 50000 }),
    product("2026-09-02", "room_a", 0, 0)];
  const f = await fixture(t, { products, nightCount: 1, dayCount: 1 });
  const result = await recoverAndRead(f);
  assert.equal(result.observations.length, 2);
  assert.ok(result.observations.every(value => value.row.stayDate === "2026-09-01"));
  assert.ok(result.recovery.warnings.some(value => value.date === "2026-09-02" && value.code === "RECOVERY_PRODUCT_DATE_MISSING"));
  assert.equal(snapshot(f, result).summary.lodging.coveredCompanyDays, 1);
});

test("a reviewed room-count conflict stays excluded after product reconstruction", async t => {
  const f = await fixture(t, { products: [product("2026-09-01", "room_a", 17, 0)], days: 1, nightCount: 1 });
  const result = await recoverAndRead(f);
  assert.equal(f.company.manualCorrection.lodgingBasisTotal, 10);
  assert.equal(result.observations.length, 1);
  const row = result.observations[0].row;
  assert.equal(row.supply, 10); assert.equal(row.inventoryConflict, true);
  const report = snapshot(f, result);
  assert.equal(report.summary.lodging.coveredCompanyDays, 0);
  assert.equal(report.quality.discardedByReason.inventory_conflict, 1);
});

test("latest valid company-date observations replace older recovered keyword results instead of adding them twice", async t => {
  const f = await fixture(t), result = await recoverAndRead(f);
  const earlier = result.observations.find(value => value.row.stayDate === "2026-09-02").row;
  const later = { ...earlier, runId: "sancheong_glamping_20260902_090000", collectedAt: "2026-09-02T00:00:00.000Z",
    collectedDate: "2026-09-02", keyword: "산청글램핑", sold: 1, publicBookings: 1, phoneBookings: 0,
    publicRevenue: 100000, phoneRevenue: 0, estimatedRevenue: 100000, phonePriceEstimates: [],
    phoneAllocatedBookings: 0, phoneAllocatedRevenue: 0, phoneRevenueLow: 0, phoneRevenueHigh: 0,
    explicitBlockedBookings: 0, explicitBlockedRevenue: 0, phonePricedBookings: 0 };
  const report = snapshot(f, { observations: [...result.observations, ...result.observations] }, {
    runs: [...f.data.runs, { id: later.runId, collectedAt: later.collectedAt, keyword: later.keyword, collectionQuality: { status: "complete" } }],
    observations: [later]
  });
  assert.equal(report.summary.lodging.coveredCompanyDays, 2);
  assert.equal(report.summary.lodging.sold, 1);
  assert.equal(report.summary.lodging.estimatedRevenue, 100000);
  assert.equal(report.sources.observations.find(value => value.date === "2026-09-02").runId, later.runId);
});

test("legacy non-array errors with numeric placeholders stay a failed response", async t => {
  const f = await fixture(t, { products: [product("2026-09-01", "room_a", 0, 0, 0,
    { errors: { message: "schedule_request_failed" }, price: 100000 })], days: 1, nightCount: 1 });
  const result = await recoverAndRead(f);
  assert.equal(result.observations.length, 0, "an error object cannot turn a placeholder zero into ten phone reservations");
  assert.equal(result.recovery.receipts.length, 0);
});
