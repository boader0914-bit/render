"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { sanitizeCollectionQuality, buildCollectionDiagnostics, readCollectionDiagnostics } = require("./lib/collection_diagnostics.cjs");
const quality = { status: "partial", reason: "product_targets_truncated", counts: { naverBookingStockChecked: 20, naverBookingStockSucceeded: 20,
  naverScheduleRequested: 560, naverScheduleSucceeded: 560, naverScheduleFailed: 0, naverScheduleBlocked: 0 } };
const row = (products = []) => ({ place_id: "123", "업체명": "검수 글램핑", "네이버예약사업자ID": "456", "네이버상품상세JSON": products });
const product = overrides => ({ date: "2026-09-27", bizItemId: "789", name: "객실 A", saleType: "숙박", stock: 0, bookingCount: 0, collectionFailed: false, ...overrides });
const target = overrides => ({ businessId: "456", discovered: 62, eligible: 62, excluded: 0, queried: 40, truncated: 22, productListComplete: true,
  expectedDays: 2, days: ["2026-09-27", "2026-09-28"].map(date => ({ date, eligible: 62, queried: 40, succeeded: 40, failed: 0, truncated: 22 })), ...overrides });

test("quality receipts retain only safe reason and known counts without secrets", () => {
  const result = sanitizeCollectionQuality({ ...quality, token: "TOKEN_SECRET", raw: "cookie=value", counts: { ...quality.counts, cookie: "COOKIE_SECRET", naverOtaFailed: false } });
  assert.equal(result.reason, quality.reason);
  assert.equal(result.counts.naverScheduleFailed, 0);
  assert.equal(result.counts.naverOtaFailed, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|cookie|raw/);
  assert.deepEqual(sanitizeCollectionQuality({ status: "complete" }), { status: "complete" });
  assert.deepEqual(sanitizeCollectionQuality({ status: "TOKEN", reason: "cookie=SECRET", blockedReason: "secret" }), { status: "unknown", reason: "unrecorded_reason" });
});

test("product cap reports distinct products and affected dates, never failed calls or room count", () => {
  const manifest = { collectionQuality: quality, counts: quality.counts, productCoverage: { targets: [target()] } };
  const before = JSON.stringify(manifest);
  const result = buildCollectionDiagnostics({ manifest, rows: [row()] });
  assert.equal(result.status, "partial"); assert.equal(result.counts.naverScheduleFailed, 0);
  assert.equal(result.counts.productTruncated, 22);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0], { code: "PRODUCT_TARGETS_TRUNCATED", label: "상품 수 제한으로 상세 조회 제외", phase: "product_list",
    companyName: "검수 글램핑", placeId: "123", bookingBusinessId: "456", bizItemId: "", productName: "", dates: ["2026-09-27", "2026-09-28"],
    affectedCount: 22, httpStatus: null, detailStatus: "recorded", countUnit: "products", expectedCount: 62, queriedCount: 40, message: "상품 수 제한으로 상세 조회 제외" });
  assert.equal(JSON.stringify(manifest), before);
});

test("normal zero remains observed while timeout and legacy failed zero remain separate", () => {
  const products = [product({ responseStatus: 200 }), product({ date: "2026-09-28", collectionFailed: true, collectionErrorCode: "TIMEOUT", responseStatus: 0 }),
    product({ date: "2026-09-29", collectionFailed: true, errors: ["TOKEN_SECRET"] })];
  const company = { ...row(products), "네이버요일별상품상세JSON": JSON.stringify(products) };
  const before = JSON.stringify(company);
  const result = buildCollectionDiagnostics({ manifest: { collectionQuality: { status: "partial", reason: "booking_schedule_responses_incomplete" },
    counts: { naverScheduleFailed: 2 } }, rows: [company] });
  assert.equal(result.observedZeroScheduleCount, 1); assert.equal(result.failedZeroScheduleCount, 2);
  assert.deepEqual(result.issues.map(item => [item.code, item.dates, item.affectedCount, item.detailStatus]), [
    ["TIMEOUT", ["2026-09-28"], 1, "recorded"], ["SCHEDULE_RESPONSE_UNRECORDED", ["2026-09-29"], 1, "unrecorded"]]);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET/);
  assert.equal(JSON.stringify(company), before);
});

test("coverage fills missing product diagnostics without double counting detailed failures", () => {
  const result = buildCollectionDiagnostics({ manifest: { collectionQuality: { status: "partial", reason: "booking_schedule_responses_incomplete" },
    counts: { naverScheduleFailed: 3 }, productCoverage: { targets: [target({ queried: 62, truncated: 0,
      days: [{ date: "2026-09-27", eligible: 62, queried: 62, succeeded: 59, failed: 3, truncated: 0 }] })] } },
    rows: [row([product({ stock: null, collectionFailed: true, collectionErrorCode: "HTTP_ERROR", responseStatus: 503 })])] });
  assert.deepEqual(result.issues.map(item => [item.code, item.affectedCount, item.httpStatus]), [["HTTP_ERROR", 1, 503], ["SCHEDULE_RESPONSE_UNRECORDED", 2, null]]);
  assert.equal(result.affectedCompanyCount, 1);
});

test("missing all availability still identifies failed company from overall row and never exposes raw text", () => {
  const result = buildCollectionDiagnostics({ manifest: { collectionQuality: { status: "partial", reason: "booking_results_incomplete" } },
    rows: [{ ...row(), "네이버예약재고수집상태": "실패: https://provider.invalid/?token=SECRET cookie=PRIVATE" }] });
  assert.equal(result.issues[0].code, "BOOKING_DETAIL_UNRECORDED");
  assert.equal(result.issues[0].companyName, "검수 글램핑");
  assert.equal(result.issues[0].countUnit, "companies");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|https:/);
});

test("missing diagnostics remain unknown and never infer successful empty collection", () => {
  const result = buildCollectionDiagnostics();
  assert.equal(result.status, "unknown"); assert.deepEqual(result.counts, {});
  assert.equal(result.issues[0].detailStatus, "unrecorded");
  const complete = buildCollectionDiagnostics({ manifest: { collectionQuality: { status: "complete", reason: "manifest_checks_passed" } }, rows: [row([product({})])] });
  assert.equal(complete.issues.length, 0); assert.equal(complete.observedZeroScheduleCount, 1);
});

test("artifact reader resolves stored JSON only inside run, preserves original bytes, and rejects traversal", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "collection-diagnostics-"));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const runDir = path.join(directory, "saved"); await fs.mkdir(path.join(runDir, "detail_json"), { recursive: true });
  const manifest = JSON.stringify({ collectionQuality: { status: "partial", reason: "booking_schedule_responses_incomplete" }, counts: { naverScheduleFailed: 1 },
    fileRoles: { overall: "rank.csv" }, collectorRunToken: "TOKEN_SECRET", outputDir: "PRIVATE_DIRECTORY" });
  const detail = JSON.stringify([product({ stock: null, collectionFailed: true, collectionErrorCode: "MISSING_SCHEDULE", responseStatus: 200 })]);
  await fs.writeFile(path.join(runDir, "manifest.json"), manifest);
  await fs.writeFile(path.join(runDir, "rank.csv"), "fixture");
  await fs.writeFile(path.join(runDir, "detail_json", "one.json"), detail);
  await fs.writeFile(path.join(directory, "outside.json"), JSON.stringify([product({ collectionFailed: true, name: "OUTSIDE_SECRET" })]));
  const rows = [{ ...row(), "네이버상품상세JSON": "@json-file:detail_json/one.json", "네이버요일별상품상세JSON": "@json-file:../outside.json" }];
  const result = await readCollectionDiagnostics({ runDir, parseCsv: () => structuredClone(rows) });
  assert.equal(result.issues[0].code, "MISSING_SCHEDULE");
  assert.equal(result.issues[0].httpStatus, 200);
  assert.ok(result.limitations.length);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_DIRECTORY/);
  assert.equal(await fs.readFile(path.join(runDir, "manifest.json"), "utf8"), manifest);
  assert.equal(await fs.readFile(path.join(runDir, "detail_json", "one.json"), "utf8"), detail);
});

test("first-search diagnosis remains visible and excludes arbitrary error text", () => {
  const failure={code:"NAVER_SEARCH_STATE_MISSING",phase:"naver_main",httpStatus:200,stack:"SECRET",message:"cookie=PRIVATE"};
  const collectionQuality=sanitizeCollectionQuality({status:"failed",reason:"collection_execution_failed",failure});
  assert.deepEqual(collectionQuality.failure,{code:failure.code,phase:"naver_main",httpStatus:200});
  const report=buildCollectionDiagnostics({manifest:{collectionQuality}});
  assert.match(report.summary,/첫 검색.*업체 목록/);
  assert.equal(report.issues.length,1); assert.equal(report.issues[0].code,failure.code); assert.equal(report.issues[0].detailStatus,"recorded");
  assert.doesNotMatch(JSON.stringify(report),/SECRET|PRIVATE|cookie|stack/);
  assert.equal(sanitizeCollectionQuality({status:"failed",failure:{code:"SECRET",phase:"naver_main"}}).failure,undefined);
});
