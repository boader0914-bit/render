"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { createSavedProductRecovery } = require("./lib/saved_product_recovery.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const RUN = "legacy_20260901", CSV = "original.csv";
const csv = row => { const quote = value => '"' + String(value ?? "").replaceAll('"', '""') + '"'; return Object.keys(row).map(quote).join(",") + "\n" + Object.values(row).map(quote).join(",") + "\n"; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saved-recovery-cache-")), runDir = path.join(root, "outputs", RUN), cacheDirectory = path.join(root, "derived_cache");
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("saved-recovery-cache-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(runDir, "details"), { recursive: true });
  const company = { companyId: "cmp_place_123", primaryName: "캐시 시험 업체", placeIds: ["123"], bookingBusinessIds: ["456"], runIds: [RUN], manualCorrection: { lodgingBasisTotal: 16 } };
  const manifest = { runId: RUN, keyword: "시험글램핑", checkIn: "2026-09-01", checkOut: "2026-09-02", bookingRangeDays: 2, collectedAt: "2026-09-01T01:00:00.000Z",
    fileRoles: { overall: CSV }, detailJsonFiles: [{ file: "details/123.json", placeId: "123", bookingBusinessId: "456", itemCount: 6 }] };
  const products = ["2026-09-01", "2026-09-02"].flatMap((date, index) => [
    { date, bizItemId: "room", name: "숙박", saleType: "숙박", stock: index ? 7 : 10, bookingCount: index ? 0 : 2, occupiedBookingCount: 0, available: index ? 7 : 8, price: index ? null : 100000, open: true },
    ...["lunch", "dinner"].map((id, position) => ({ date, bizItemId: id, name: position ? "디너" : "런치", saleType: "데이유즈", stock: 3, bookingCount: 1, occupiedBookingCount: 0, available: 2, price: 15000, open: true }))
  ]);
  const row = { place_id: "123", "네이버예약사업자ID": "456", "업체명": company.primaryName, url: "https://m.place.naver.com/accommodation/123/home", "숙박상품수": 1, "데이유즈상품수": 2,
    "예약계산대상상품수": 1, "네이버예약재고수집상태": "조회완료", "네이버요일별상품상세JSON": "@json-file:details/123.json" };
  const originals = [path.join(runDir, "manifest.json"), path.join(runDir, CSV), path.join(runDir, "details", "123.json")];
  await fs.writeFile(originals[0], JSON.stringify(manifest)); await fs.writeFile(originals[1], csv(row)); await fs.writeFile(originals[2], JSON.stringify(products));
  const data = { rawCompanies: new Map([[company.companyId, company]]), companies: [{ companyId: company.companyId }], runs: [{ ...manifest, id: RUN, collectionQuality: null }] };
  let captured = "", assertions = 0;
  const revision = async () => hash(JSON.stringify([company, data.runs, ...await Promise.all(originals.map(async filename => { const value = await fs.stat(filename, { bigint: true }); return [value.size, value.mtimeNs, value.ctimeNs, value.ino, value.dev].map(String); }))]));
  const owner = { revision: "", assertCurrent: async () => { assertions++; if (await revision() !== captured) throw Object.assign(Error("changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" }); } };
  data._companySource = owner;
  const options = { dataDir: root, cacheDirectory, cacheVersion: "test-v1", useSourceReadValidationBoundary: true, projectCompany: value => value,
    applyCompanyManualCorrection: (item, current) => applyInventoryEvidence({ ...item, inventoryCapacityBaseline: { ...item.inventoryCapacityBaseline, lodgingOverride: { count: current.manualCorrection.lodgingBasisTotal } } }),
    buildHistoryObservations: value => ["lodging", "dayuse"].flatMap(kind => (value.availability.items[0].inventoryEvidence[kind === "lodging" ? "lodging" : "dayUse"]?.rows || []).map(daily => ({ ...daily,
      productType: kind, stayDate: daily.date, supply: daily.total, inventoryEvidenceVersion: 4 }))), now: () => new Date("2026-10-25T00:00:00Z") };
  const helper = createSavedProductRecovery(options), request = { type: "company", targetId: company.companyId, month: "2026-09", cutoffDate: "2026-09-30" };
  captured = await revision(); owner.revision = captured;
  await helper.recover({ month: request.month, companyIds: [company.companyId] }, data);
  const refresh = async () => { captured = await revision(); owner.revision = captured; };
  await refresh();
  const boundary = () => { let active = true; return { value: Object.freeze({ owner, revision: owner.revision, isActive: () => active }), stop: () => { active = false; } }; };
  const list = async kind => { try { return (await fs.readdir(path.join(cacheDirectory, kind))).filter(name => name.endsWith(".json.gz")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
  return { root, cacheDirectory, company, manifest, products, originals, data, owner, options, helper, request, boundary, refresh, list, assertions: () => assertions };
}
test("verified evidence and observation units survive restart, preserve exact output and eliminate repeated raw hash/parse work", async t => {
  const f = await fixture(t), boundary = f.boundary(), readOptions = { sourceReadValidationBoundary: boundary.value };
  const originalBytes = new Map(await Promise.all(f.originals.map(async filename => [filename, await fs.readFile(filename)])));
  const expected = await createSavedProductRecovery({ ...f.options, cacheDirectory: null }).read(f.request, f.data);
  const before = f.helper.stats(), evidence = await f.helper.capacityEvidence(f.request, f.data, readOptions);
  const first = await f.helper.read(f.request, f.data, { ...readOptions, productCapacityEvidence: evidence });
  const afterFirst = f.helper.stats(); assert.equal(afterFirst.evidenceBuilds, 1); assert.equal(afterFirst.rowBuilds, 1); assert.equal(afterFirst.sourceReads - before.sourceReads, 2);
  assert.deepEqual(first.observations, expected.observations); assert.ok(first.observations.some(entry => entry.row.productType === "lodging"));
  assert.deepEqual(await f.helper.read(f.request, f.data, { ...readOptions, productCapacityEvidence: evidence }), first);
  assert.equal(f.helper.stats().sourceReads, afterFirst.sourceReads); assert.equal(f.helper.stats().sourceFileReads, afterFirst.sourceFileReads);
  const restarted = createSavedProductRecovery(f.options); assert.deepEqual(await restarted.read(f.request, f.data, { ...readOptions, productCapacityEvidence: evidence }), first);
  assert.equal(restarted.stats().sourceReads, 0); assert.equal(restarted.stats().evidenceHits, 1); assert.equal(restarted.stats().rowHits, 1);
  assert.ok(f.assertions() > 4, "fresh catalog checks still surround saved-unit reuse");
  for (const kind of ["receipt_capacity", "receipt_rows"]) {
    const names = await f.list(kind); assert.equal(names.length, 1);
    const entry = JSON.parse(zlib.gunzipSync(await fs.readFile(path.join(f.cacheDirectory, kind, names[0]))));
    assert.deepEqual(Object.keys(entry.value).sort(), ["companyId", "derived", "kind", "month", "receiptId", "runId"]);
    assert.equal(entry.value.manifest, undefined); assert.equal(entry.value.products, undefined); assert.equal(entry.value.value, undefined);
  }
  for (const filename of f.originals) assert.deepEqual(await fs.readFile(filename), originalBytes.get(filename));
});
test("missing source capability bypasses units while wrong or expired capabilities fail closed", async t => {
  const f = await fixture(t); await f.helper.read(f.request, f.data); const first = f.helper.stats().sourceReads;
  await f.helper.read(f.request, f.data); assert.equal(f.helper.stats().sourceReads - first, 2); assert.deepEqual(await f.list("receipt_capacity"), []);
  for (const boundary of [{ owner: {}, revision: f.owner.revision, isActive: () => true }, { owner: f.owner, revision: "wrong", isActive: () => true }, { owner: f.owner, revision: f.owner.revision, isActive: () => false }]) {
    await assert.rejects(f.helper.read(f.request, f.data, { sourceReadValidationBoundary: boundary }), error => error.code === "RECOVERY_SOURCE_BOUNDARY_INVALID");
  }
});
test("review, request scope, warning and as-of capacity changes cannot reuse an incompatible observation unit", async t => {
  const f = await fixture(t); let boundary = f.boundary(), options = { sourceReadValidationBoundary: boundary.value };
  const first = await f.helper.read(f.request, f.data, options), initial = f.helper.stats().rowBuilds;
  const normal = { companyId: f.company.companyId, productId: "room", productType: "lodging", count: 15, collectedAt: "2026-08-01T00:00:00.000Z", sourceDate: "2026-08-02", runId: "normal", source: "normal_saved_product_response" };
  const changedCapacity = await f.helper.read(f.request, f.data, { ...options, productCapacityEvidence: [normal] }); assert.equal(f.helper.stats().rowBuilds, initial + 1);
  const baseline = createSavedProductRecovery({ ...f.options, cacheDirectory: null }); assert.deepEqual(changedCapacity, await baseline.read(f.request, f.data, { productCapacityEvidence: [normal] }));
  const future = { ...normal, count: 99, collectedAt: "2026-10-01T00:00:00.000Z" };
  const withFuture = await f.helper.read(f.request, f.data, { ...options, productCapacityEvidence: [future] }); assert.deepEqual(withFuture.observations, first.observations);
  const beforeWarning = f.helper.stats().rowBuilds;
  await f.helper.read(f.request, f.data, { ...options, productCapacityWarnings: [{ companyId: f.company.companyId, code: "TEST_WARNING", message: "근거 확인" }] }); assert.equal(f.helper.stats().rowBuilds, beforeWarning + 1);
  const scoped = await f.helper.read({ ...f.request, type: "industry", targetId: "__industry_all__" }, f.data, options); assert.deepEqual(scoped.observations, first.observations);
  assert.ok((await f.list("receipt_rows")).length >= 2, "request scopes have independent file keys");
  f.company.manualCorrection.lodgingBasisTotal = 8; await f.refresh(); boundary = f.boundary(); options = { sourceReadValidationBoundary: boundary.value };
  const reviewed = await f.helper.read(f.request, f.data, options); assert.deepEqual(reviewed, await baseline.read(f.request, f.data)); assert.notDeepEqual(reviewed.observations, first.observations);
  const newCode = createSavedProductRecovery({ ...f.options, cacheVersion: "test-v2" }); await newCode.read(f.request, f.data, options); assert.equal(newCode.stats().rowBuilds, 1);
});
test("corrupt gzip and checksum-valid wrong-scope payloads fall back to freshly verified derived rows", async t => {
  const f = await fixture(t), options = { sourceReadValidationBoundary: f.boundary().value }, expected = await f.helper.read(f.request, f.data, options);
  const capacityFile = path.join(f.cacheDirectory, "receipt_capacity", (await f.list("receipt_capacity"))[0]); await fs.writeFile(capacityFile, "{bad");
  const before = f.helper.stats(); assert.deepEqual(await f.helper.read(f.request, f.data, options), expected); assert.equal(f.helper.stats().evidenceBuilds, before.evidenceBuilds + 1);
  const rowsFile = path.join(f.cacheDirectory, "receipt_rows", (await f.list("receipt_rows"))[0]), entry = JSON.parse(zlib.gunzipSync(await fs.readFile(rowsFile)));
  entry.value.companyId = "another-company"; entry.valueHash = hash(JSON.stringify(entry.value)); await fs.writeFile(rowsFile, zlib.gzipSync(JSON.stringify(entry)));
  assert.deepEqual(await f.helper.read(f.request, f.data, options), expected); assert.equal(f.helper.stats().invalidCacheFallbacks, 1);
});
test("oversize units retain uncached output without publishing or retaining raw product payloads", async t => {
  const f = await fixture(t), options = { sourceReadValidationBoundary: f.boundary().value }, expected = await f.helper.read(f.request, f.data);
  const small = createSavedProductRecovery({ ...f.options, maxCachedUnitBytes: 128 }); assert.deepEqual(await small.read(f.request, f.data, options), expected);
  assert.equal(small.stats().oversizeFallbacks, 2); assert.deepEqual(await f.list("receipt_capacity"), []); assert.deepEqual(await f.list("receipt_rows"), []);
});
test("a yielded read returns no partial normal observations but retries reuse completed certified units", async t => {
  const f = await fixture(t), boundary = f.boundary(), yielded = Object.assign(Error("yield"), { code: "ANALYTICAL_WORK_YIELDED" }); let returned = false;
  await assert.rejects((async () => { const result = await f.helper.read(f.request, f.data, { sourceReadValidationBoundary: boundary.value, checkpoint: async () => {
    if ((await f.list("receipt_capacity")).length) throw yielded;
  } }); returned = true; return result; })(), error => error === yielded);
  assert.equal(returned, false); assert.equal((await f.list("receipt_capacity")).length, 1); assert.equal((await f.list("receipt_rows")).length, 0);
  boundary.stop(); const before = f.helper.stats().sourceReads;
  const actual = await f.helper.read(f.request, f.data, { sourceReadValidationBoundary: f.boundary().value });
  assert.deepEqual(actual, await createSavedProductRecovery({ ...f.options, cacheDirectory: null }).read(f.request, f.data));
  assert.equal(f.helper.stats().sourceReads - before, 1); assert.ok(f.helper.stats().evidenceHits >= 1);
});
test("original changes during a warm hit fail the final catalog boundary instead of returning a normal cached result", async t => {
  const f = await fixture(t), options = { sourceReadValidationBoundary: f.boundary().value }; await f.helper.read(f.request, f.data, options);
  let changed = false;
  await assert.rejects(f.helper.read(f.request, f.data, { ...options, checkpoint: async () => {
    if (!changed && f.helper.stats().evidenceHits) { changed = true; await fs.appendFile(f.originals[2], " "); }
  } }), error => error.code === "MONTHLY_COMPANY_SOURCE_CHANGED");
  await f.refresh();
  await assert.rejects(f.helper.read(f.request, f.data, { sourceReadValidationBoundary: f.boundary().value }), error => error.code === "RECOVERY_SOURCE_CHANGED");
});
