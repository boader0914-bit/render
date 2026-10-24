"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createSavedProductRecovery, recoveryRowDigest } = require("./lib/saved_product_recovery.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const CSV = "경남_네이버전체순위.csv", RUN = "gyeongnam_glamping_20260901_100450";
function csv(row) { const quote = value => '"' + String(value ?? "").replaceAll('"', '""') + '"'; return Object.keys(row).map(quote).join(",") + "\n" + Object.values(row).map(quote).join(",") + "\n"; }
async function fixture(t, { dayuse = false, days = 2 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saved-product-recovery-")), outputs = path.join(root, "outputs"), runDir = path.join(outputs, RUN);
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(runDir, "details"), { recursive: true });
  const company = { companyId: "cmp_place_123", primaryName: "저장글램핑", placeIds: ["123"], bookingBusinessIds: ["456"], runIds: [RUN], manualCorrection: { lodgingBasisTotal: 10 } };
  const products = [];
  for (let index = 0; index < days; index++) {
    const date = "2026-09-" + String(index + 1).padStart(2, "0");
    products.push({ date, bizItemId: "room1", name: "숙박 A", saleType: "숙박", bizItemSubType: "ACCOMMODATION_NIGHT", listType: "객실 묶음 상품리스트",
      stock: 10, bookingCount: index ? 0 : 2, occupiedBookingCount: 0, available: index ? 10 : 8, price: 100000, open: true });
    if (dayuse) products.push({ date, bizItemId: "day1", name: "데이유즈", saleType: "데이유즈", stock: 3, bookingCount: 1, occupiedBookingCount: 0, available: 2, price: 10000, open: true });
  }
  const manifest = { runId: RUN, keyword: "경남글램핑", checkIn: "2026-09-01", checkOut: "2026-09-02", bookingRangeDays: days, collectedAt: "2026-09-01T01:09:57.838Z",
    fileRoles: { overall: CSV }, detailJsonFiles: [{ file: "details/123_weekly.json", placeId: "123", bookingBusinessId: "456", itemCount: products.length }] };
  const row = { place_id: "123", "네이버예약사업자ID": "456", "업체명": "저장글램핑", url: "https://m.place.naver.com/accommodation/123/home",
    "숙박상품수": 1, "데이유즈상품수": dayuse ? 1 : 0, "예약계산대상상품수": 1, "네이버예약재고수집상태": "조회완료", "네이버요일별상품상세JSON": "@json-file:details/123_weekly.json" };
  const data = { rawCompanies: new Map([[company.companyId, company]]), companies: [{ companyId: company.companyId }], runs: [{ ...manifest, id: RUN, collectionQuality: null }] };
  const write = async () => { manifest.detailJsonFiles[0].itemCount = products.length;
    await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest)); await fs.writeFile(path.join(runDir, CSV), csv(row));
    await fs.writeFile(path.join(runDir, "details", "123_weekly.json"), JSON.stringify(products)); };
  await write();
  const options = { dataDir: root, outputsDir: outputs, projectCompany: value => value,
    applyCompanyManualCorrection: (item, current) => applyInventoryEvidence({ ...item, inventoryCapacityBaseline: { lodgingOverride: { count: current.manualCorrection.lodgingBasisTotal } } }),
    buildHistoryObservations: (value, collectedAt) => ["lodging", "dayuse"].flatMap(kind => (value.availability.items[0].inventoryEvidence[kind === "lodging" ? "lodging" : "dayUse"]?.rows || []).map(daily => ({
      ...daily, productType: kind, stayDate: daily.date, supply: daily.total, inventoryEvidenceVersion: 4, collectedAt
    }))), now: () => new Date("2026-10-24T04:00:00Z") };
  const helper = createSavedProductRecovery(options), input = { month: "2026-09", companyIds: [company.companyId] }, request = { type: "company", targetId: company.companyId, month: input.month, cutoffDate: "2026-09-30" };
  return { root, runDir, company, products, manifest, row, data, write, options, helper, input, request };
}

test("canonical row digest is stable across object order and distinct for null versus zero", () => {
  assert.equal(recoveryRowDigest({ b: [2, { b: 2, a: 1 }], a: 1 }), recoveryRowDigest({ a: 1, b: [2, { a: 1, b: 2 }] }));
  assert.notEqual(recoveryRowDigest({ sold: 0 }), recoveryRowDigest({ sold: null }));
});
test("verified legacy products create immutable idempotent receipts and scope-bound certificates without modifying originals", async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.runDir, "manifest.json"));
  const first = await f.helper.recover(f.input, f.data), second = await f.helper.recover(f.input, f.data);
  assert.equal(first.receipts.length, 1); assert.equal(first.receipts[0].created, true); assert.equal(second.receipts[0].created, false);
  assert.equal(first.receipts[0].receiptId, second.receipts[0].receiptId);
  const read = await f.helper.read(f.request, f.data);
  assert.equal(read.observations.length, 2); assert.deepEqual(read.warnings, []);
  assert.equal(read.observations[1].row.sold, 0, "normal zero remains zero");
  for (const { row, certificate } of read.observations) {
    assert.equal(certificate.originalRunQuality, "unknown"); assert.equal(certificate.kind, "saved_product_recovery_v1");
    assert.equal(certificate.companyId, f.company.companyId); assert.equal(certificate.date, row.stayDate);
    assert.equal(certificate.rowDigest, recoveryRowDigest(row)); assert.match(certificate.sourceDigest, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(await fs.readFile(path.join(f.runDir, "manifest.json")), original);
  assert.equal(f.data.runs[0].collectionQuality, null);
});
test("read survives restart and uses current DB correction while immutable original receipt stays the same", async t => {
  const f = await fixture(t); await f.helper.recover(f.input, f.data);
  const before = await f.helper.read(f.request, f.data); f.company.manualCorrection.lodgingBasisTotal = 8;
  const after = await createSavedProductRecovery(f.options).read(f.request, f.data);
  assert.equal(after.observations[0].row.supply, 8); assert.equal(after.observations[0].row.inventoryConflict, true);
  assert.equal(before.observations[0].certificate.receiptId, after.observations[0].certificate.receiptId);
  assert.notEqual(before.observations[0].certificate.rowDigest, after.observations[0].certificate.rowDigest);
});
test("a failed day is excluded without losing a different normal date or reusing the failed price", async t => {
  const f = await fixture(t); f.products[0].collectionFailed = true; f.products[1].price = null; await f.write();
  const recovered = await f.helper.recover(f.input, f.data); assert.equal(recovered.receipts[0].verifiedObservationCount, 1);
  assert.ok(recovered.warnings.some(value => value.date === "2026-09-01"));
  const read = await f.helper.read(f.request, f.data); assert.equal(read.observations[0].row.stayDate, "2026-09-02");
  assert.deepEqual(read.observations[0].row.phonePriceEstimates, []);
});
test("missing or invalid day-use detail forbids lodging recovery for that date", async t => {
  const f = await fixture(t, { dayuse: true }); f.products.splice(f.products.findIndex(value => value.date === "2026-09-02" && value.saleType === "데이유즈"), 1); await f.write();
  const recovered = await f.helper.recover(f.input, f.data); assert.equal(recovered.receipts[0].verifiedObservationCount, 2);
  const read = await f.helper.read(f.request, f.data); assert.deepEqual(read.observations.map(value => value.row.stayDate), ["2026-09-01", "2026-09-01"]);
  assert.equal(read.observations.find(value => value.row.productType === "lodging").row.sharedDayUseExcluded, 0);
});
test("a product absent for the entire range is rejected against the recorded product count", async t => {
  const f = await fixture(t); f.row["숙박상품수"] = 2; f.row["예약계산대상상품수"] = 2; await f.write();
  const result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 0);
  assert.ok(result.warnings.some(value => value.code === "RECOVERY_PRODUCT_LIST_INCOMPLETE"));
});
test("a contradictory duplicate product or provider identity is rejected, never name matched", async t => {
  const f = await fixture(t); f.products.push({ ...f.products[0], stock: 9 }); await f.write();
  let result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 0); assert.equal(result.warnings[0].code, "RECOVERY_DUPLICATE_PRODUCT_CONFLICT");
  f.products.pop(); f.row["네이버예약사업자ID"] = "999"; await f.write(); result = await f.helper.recover(f.input, f.data);
  assert.equal(result.receipts.length, 0); assert.equal(result.warnings[0].code, "RECOVERY_PROVIDER_ID_AMBIGUOUS");
});
test("basis and weekly display units or coupons may differ but economic values must match", async t => {
  const f = await fixture(t); f.products[0].availabilityUnit = "묶음상품"; f.products[0].couponNames = "쿠폰 A";
  f.row["네이버상품상세JSON"] = JSON.stringify([{ ...f.products[0], availabilityUnit: "재고수량", couponNames: "쿠폰 B" }]); await f.write();
  const result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].verifiedObservationCount, 2);
  const changed = JSON.parse(f.row["네이버상품상세JSON"]); changed[0].price = 200000; f.row["네이버상품상세JSON"] = JSON.stringify(changed); await f.write();
  const invalid = await f.helper.recover(f.input, f.data); assert.equal(invalid.receipts.length, 0); assert.equal(invalid.warnings[0].code, "RECOVERY_DUPLICATE_PRODUCT_CONFLICT");
});
test("catalog identity collision, filesystem time and post-stay observations cannot become valid evidence", async t => {
  const f = await fixture(t); f.data.rawCompanies.set("other", { companyId: "other", placeIds: ["123"], bookingBusinessIds: [] });
  let result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 0);
  f.data.rawCompanies.delete("other"); f.manifest.collectedAtSource = "filesystem"; await f.write();
  result = await f.helper.recover(f.input, f.data); assert.equal(result.warnings[0].code, "RECOVERY_TIME_UNVERIFIED");
  delete f.manifest.collectedAtSource; f.manifest.collectedAt = "2026-09-03T01:00:00Z"; await f.write();
  result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 0);
});
test("non-legacy failed, blocked and partial runs are never upgraded", async t => {
  const f = await fixture(t);
  for (const status of ["failed", "blocked", "interrupted", "partial", "complete", "reused"]) {
    f.data.runs[0].collectionQuality = { status }; assert.equal((await f.helper.recover(f.input, f.data)).receipts.length, 0);
  }
  f.data.runs[0].collectionQuality = null; f.manifest.collectionQuality = { status: "blocked" }; await f.write();
  assert.equal((await f.helper.recover(f.input, f.data)).warnings[0].code, "RECOVERY_RUN_NOT_LEGACY");
});
test("receipt tampering and original file change exclude the recovery instead of retaining stale data", async t => {
  const f = await fixture(t), saved = await f.helper.recover(f.input, f.data), receiptId = saved.receipts[0].receiptId;
  f.products[0].price = 900000; await f.write();
  await assert.rejects(f.helper.read(f.request, f.data), error => error.code === "RECOVERY_SOURCE_CHANGED");
  // company directory is sha256(string), independent of canonical JSON quoting.
  const folder = (await fs.readdir(f.helper.directory))[0], file = path.join(f.helper.directory, folder, f.input.month, receiptId + ".json");
  const payload = JSON.parse(await fs.readFile(file, "utf8")); payload.collectedAt = "2026-08-01T00:00:00Z"; await fs.writeFile(file, JSON.stringify(payload));
  await assert.rejects(f.helper.read(f.request, f.data), error => error.code === "RECOVERY_RECEIPT_INVALID");
});
test("invalid numbers, missing open, over-occupied counts and inconsistent availability remain unverified", async t => {
  for (const mutate of [row => { row.stock = ""; }, row => { row.stock = false; }, row => { row.stock = 1.5; }, row => { delete row.open; },
    row => { row.occupiedBookingCount = 20; }, row => { row.available = 100; }, row => { row.collectionErrorCode = "PROVIDER_BLOCKED"; },
    row => { row.errors = { message: "failed" }; }, row => { row.queryAttempted = "false"; }, row => { row.collectionFailed = "false"; },
    row => { row.responseStatus = true; }]) {
    const f = await fixture(t); mutate(f.products[0]); await f.write();
    const result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts[0].verifiedObservationCount, 1);
    assert.equal((await f.helper.read(f.request, f.data)).observations[0].row.stayDate, "2026-09-02");
  }
});
test("out of root references and manifest detail count mismatch are rejected", async t => {
  const f = await fixture(t); f.row["네이버요일별상품상세JSON"] = "@json-file:../outside.json";
  f.manifest.detailJsonFiles[0].file = "../outside.json"; await f.write();
  let result = await f.helper.recover(f.input, f.data); assert.equal(result.receipts.length, 0);
  assert.equal(result.warnings[0].code, "RECOVERY_ARTIFACT_PATH_INVALID");
  f.row["네이버요일별상품상세JSON"] = "@json-file:details/123_weekly.json"; f.manifest.detailJsonFiles[0].file = "details/123_weekly.json"; await f.write();
  f.manifest.detailJsonFiles[0].itemCount = 99; await fs.writeFile(path.join(f.runDir, "manifest.json"), JSON.stringify(f.manifest));
  result = await f.helper.recover(f.input, f.data); assert.equal(result.warnings[0].code, "RECOVERY_DETAIL_COUNT_CONFLICT");
});
test("a changing catalog stops publication before any receipt is written", async t => {
  const f = await fixture(t); let calls = 0; f.data._companySource = { assertCurrent: async () => { if (++calls > 1) throw Object.assign(new Error("changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" }); } };
  await assert.rejects(f.helper.recover(f.input, f.data), error => error.code === "MONTHLY_COMPANY_SOURCE_CHANGED");
  await assert.rejects(fs.readdir(f.helper.directory), error => error.code === "ENOENT");
});

async function storedReceipt(f, result) {
  const id = result.receipts[0].receiptId, folders = await fs.readdir(f.helper.directory);
  const file = path.join(f.helper.directory, folders[0], f.input.month, id + ".json");
  return { file, value: JSON.parse(await fs.readFile(file, "utf8")) };
}
test("recorded day-use sale type normalizes a contradictory provider subtype in the derived input and its receipt only", async t => {
  for (const name of ["글램핑A당일치기(랜덤,숙박불가,당일7시간,노키즈)1", "[숙박X 당일6시간이용]랜덤객실1", "2호점 글램핑 [당일치기]"]) {
    const f = await fixture(t, { dayuse: true });
    for (const row of f.products) {
      if (row.saleType === "데이유즈") { row.bizItemSubType = "ACCOMMODATION_NIGHT"; row.name = name; }
      else if (row.date === "2026-09-01") { row.occupiedBookingCount = 1; row.available = 7; }
    }
    await f.write();
    const originalProducts = await fs.readFile(path.join(f.runDir, "details", "123_weekly.json"));
    const originalManifest = await fs.readFile(path.join(f.runDir, "manifest.json"));
    const result = await f.helper.recover(f.input, f.data);
    assert.equal(result.receipts.length, 1, JSON.stringify(result.warnings));
    const saved = await storedReceipt(f, result), read = await f.helper.read(f.request, f.data);
    assert.equal(saved.value.validatorVersion, 2);
    assert.equal(saved.value.classificationNormalizations.length, 2);
    assert.deepEqual(saved.value.classificationNormalizations[0], { date: "2026-09-01", productId: "day1",
      reason: "recorded_sale_type_precedence", source: { saleType: "데이유즈", bizItemSubType: "ACCOMMODATION_NIGHT" },
      applied: { saleType: "데이유즈", bizItemSubType: "" }, productType: "dayuse" });
    const lodging = read.observations.find(value => value.row.productType === "lodging" && value.row.stayDate === "2026-09-01").row;
    const dayUse = read.observations.find(value => value.row.productType === "dayuse" && value.row.stayDate === "2026-09-01").row;
    assert.equal(lodging.supply, 10); assert.equal(lodging.publicBookings, 2); assert.equal(lodging.sharedDayUseExcluded, 1);
    assert.equal(lodging.phoneBookings, 0); assert.equal(lodging.inventoryConflict, false);
    assert.equal(dayUse.sold, 1); assert.equal(dayUse.estimatedRevenue, 10000);
    assert.equal(lodging.estimatedRevenue, 200000, "day-use sales never become overnight room sales");
    assert.deepEqual(await fs.readFile(path.join(f.runDir, "details", "123_weekly.json")), originalProducts);
    assert.deepEqual(await fs.readFile(path.join(f.runDir, "manifest.json")), originalManifest);
    assert.deepEqual(f.products.filter(row => row.saleType === "데이유즈").map(row => row.bizItemSubType), ["ACCOMMODATION_NIGHT", "ACCOMMODATION_NIGHT"]);
    const afterRestart = await createSavedProductRecovery(f.options).read(f.request, f.data);
    assert.deepEqual(afterRestart, read, "receipt scope and row digest reproduce after restart");
  }
});
test("ambiguous explicit sale types and contradictory subtype labels remain unverified", async t => {
  for (const values of [{ saleType: "숙박/데이유즈", bizItemSubType: "ACCOMMODATION_NIGHT" },
    { saleType: "미분류", bizItemSubType: "ACCOMMODATION_NIGHT" }, { saleType: "기타", bizItemSubType: "ACCOMMODATION_DAY_USE" },
    { saleType: true, bizItemSubType: "ACCOMMODATION_NIGHT" },
    { saleType: "데이유즈", bizItemSubType: "ACCOMMODATION_NIGHT DAY_USE" }]) {
    const f = await fixture(t); Object.assign(f.products[0], values); await f.write();
    const result = await f.helper.recover(f.input, f.data);
    assert.equal(result.receipts.length, 0); assert.equal(result.warnings[0].code, "RECOVERY_PRODUCT_ID_UNVERIFIED");
  }
});
test("normalized classifications must still match each complete CSV lodging and day-use count", async t => {
  const f = await fixture(t, { dayuse: true });
  for (const row of f.products) if (row.saleType === "데이유즈") row.bizItemSubType = "ACCOMMODATION_NIGHT";
  f.row["숙박상품수"] = 2; f.row["예약계산대상상품수"] = 2; f.row["데이유즈상품수"] = 0; await f.write();
  const result = await f.helper.recover(f.input, f.data);
  assert.equal(result.receipts.length, 0); assert.equal(result.warnings[0].code, "RECOVERY_PRODUCT_LIST_INCOMPLETE");
});
async function replaceWithV1Receipt(f, result) {
  const saved = await storedReceipt(f, result);
  const { checksum, receiptId, createdAt, classificationNormalizations, ...source } = saved.value;
  const core = { ...source, validatorVersion: 1 }, legacyId = recoveryRowDigest(core);
  const value = { ...core, receiptId: legacyId, createdAt }; value.checksum = recoveryRowDigest(value);
  const file = path.join(path.dirname(saved.file), legacyId + ".json");
  await fs.writeFile(file, JSON.stringify(value), { flag: "wx" });
  assert.ok(saved.file.startsWith(f.root + path.sep)); await fs.unlink(saved.file);
  return { file, value };
}
test("version-one valid receipts remain readable and unchanged without requiring re-recovery", async t => {
  const f = await fixture(t), result = await f.helper.recover(f.input, f.data);
  const legacy = await replaceWithV1Receipt(f, result), before = await fs.readFile(legacy.file);
  const read = await createSavedProductRecovery(f.options).read(f.request, f.data);
  assert.equal(read.observations.length, 2); assert.equal(read.observations[1].row.sold, 0);
  assert.equal(read.observations[0].certificate.receiptId, legacy.value.receiptId);
  assert.deepEqual(await fs.readFile(legacy.file), before);
  assert.deepEqual(await fs.readdir(path.dirname(legacy.file)), [path.basename(legacy.file)], "read creates no replacement version-two receipt");
});
test("a fabricated version-one receipt cannot authorize newly normalized classification conflicts", async t => {
  const f = await fixture(t, { dayuse: true });
  for (const row of f.products) if (row.saleType === "데이유즈") row.bizItemSubType = "ACCOMMODATION_NIGHT";
  await f.write(); const result = await f.helper.recover(f.input, f.data);
  assert.equal(result.receipts.length, 1); await replaceWithV1Receipt(f, result);
  await assert.rejects(f.helper.read(f.request, f.data), error => error.code === "RECOVERY_RECEIPT_INVALID");
});
