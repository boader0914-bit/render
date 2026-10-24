"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

async function seedLegacyRecoveryFixture(dataDir) {
  const companyId = "cmp_place_1104404759", runId = "gyeongnam_glamping_20260901_090000", collectedAt = "2026-09-01T00:10:00.000Z";
  const directory = path.join(dataDir, "outputs", runId), details = "details/1104404759_weekly_product_details_fixture.json";
  const product = (date, id, bookings, occupied = 0) => ({ date, key: `id:${id}`, bizItemId: id, name: `숙박 ${id}`,
    saleType: "숙박", bizItemSubType: "ACCOMMODATION_NIGHT", listType: "객실 종류별 리스트", availabilityUnit: "재고수량",
    total: 5, available: 5 - bookings - occupied, soldOut: bookings + occupied, stock: 5, bookingCount: bookings,
    occupiedBookingCount: occupied, price: 100000, open: true });
  const products = [product("2026-09-01", "room_a", 0), product("2026-09-01", "room_b", 0),
    product("2026-09-02", "room_a", 2, 2), product("2026-09-02", "room_b", 1)];
  const manifest = { id: runId, runId, keyword: "경남글램핑", collectedAt, checkIn: "2026-09-01", checkOut: "2026-09-02",
    bookingRangeDays: 2, collectionPurpose: "revenue_detail", collectionQuality: null,
    fileRoles: { overall: "경남글램핑_네이버전체순위.csv" }, detailJsonFiles: [{ field: "weekly_product_details", name: "시즌글램핑",
      placeId: "1104404759", bookingBusinessId: "1040638", file: details, itemCount: products.length }] };
  const row = { place_id: "1104404759", bookingBusinessId: "1040638", "업체명": "시즌글램핑", overall_rank: 1,
    "네이버예약URL": "https://booking.naver.com/booking/3/bizes/1040638", "숙박상품수": 2, "데이유즈상품수": 0,
    "예약계산대상상품수": 2, "네이버요일별상품상세JSON": `@json-file:${details}` };
  const columns = Object.keys(row), cell = value => `"${String(value).replace(/"/g, '""')}"`;
  await fs.mkdir(path.join(directory, "details"), { recursive: true });
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, details), JSON.stringify(products));
  await fs.writeFile(path.join(directory, manifest.fileRoles.overall), columns.map(cell).join(",") + "\r\n" + columns.map(key => cell(row[key])).join(",") + "\r\n");
  const masterPath = path.join(dataDir, "company_master", "companies.json"), master = JSON.parse(await fs.readFile(masterPath, "utf8"));
  master.companies[companyId] = { companyId, primaryName: "시즌글램핑", addresses: ["경상남도 산청군 모의 주소"], regions: ["산청"],
    placeIds: ["1104404759"], bookingBusinessIds: ["1040638"], manualCorrection: { active: true, lodgingBasisTotal: 10 },
    keywords: { "경남글램핑": { keyword: "경남글램핑", runs: [{ runId, collectedAt, rank: 1 }] } }, inventory: {} };
  await fs.writeFile(masterPath, JSON.stringify(master));
  return { companyId, runId, directory, details };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const legacy = await seedLegacyRecoveryFixture(dataDir);
  const originalHistory = await fs.readFile(path.join(dataDir, "history", "observations.jsonl"));
  const originalMaster = await fs.readFile(path.join(dataDir, "company_master", "companies.json"));
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, preload = path.join(dataDir, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { throw new Error('External requests forbidden'); };\n");
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "integrated-admin", GLAMPING_ADMIN_PASSWORD: "integrated-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "integrated-member", GLAMPING_B2B_PASSWORD: "integrated-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "integrated-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  try {
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = `/api/company-master/integrated?companyId=${fixture.companyId}&month=2026-08`;
    assert.equal((await request(url)).status, 401);
    assert.equal((await request(url, await login("integrated-member"))).status, 403);
    const admin = await login("integrated-admin");
    const recoveryRoute = "/api/company-master/recover-saved-products";
    const recoveryRequest = { confirm: "recover-saved-products", month: "2026-08", companyIds: [fixture.companyId] };
    assert.equal((await request(recoveryRoute, "", "POST", recoveryRequest)).status, 401);
    assert.equal((await request(recoveryRoute, await login("integrated-member"), "POST", recoveryRequest)).status, 403);
    assert.equal((await request(recoveryRoute, admin, "POST", { ...recoveryRequest, confirm: undefined })).status, 400);
    assert.equal((await request(recoveryRoute, admin, "POST", { ...recoveryRequest, rawRows: [] })).status, 400);
    const recovered = await request(recoveryRoute, admin, "POST", recoveryRequest);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    assert.equal(recovered.data.collectionExecuted, false);
    assert.equal(recovered.data.receipts.length, 0, "complete and unverifiable legacy runs cannot be relabelled as recovered");
    const refreshRoute = "/api/company-master/refresh-saved-products";
    const refreshRequest = { ...recoveryRequest, confirm: "refresh-saved-products" };
    assert.equal((await request(refreshRoute, "", "POST", refreshRequest)).status, 401);
    assert.equal((await request(refreshRoute, await login("integrated-member"), "POST", refreshRequest)).status, 403);
    for (const invalid of [{ ...refreshRequest, confirm: undefined }, { ...refreshRequest, month: "2026-13" },
      { ...refreshRequest, rawRows: [] }, { ...refreshRequest, companyIds: [] },
      { ...refreshRequest, companyIds: [fixture.companyId, fixture.companyId] },
      { ...refreshRequest, companyIds: ["../escape"] },
      { ...refreshRequest, companyIds: Array.from({ length: 11 }, (_, index) => `cmp_place_${index}`) }]) {
      assert.equal((await request(refreshRoute, admin, "POST", invalid)).status, 400);
    }
    const originDenied = await fetch(base + refreshRoute, { method: "POST", headers: { Cookie: admin,
      "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify(refreshRequest) });
    assert.equal(originDenied.status, 403, "the repair route retains same-origin write protection");
    const skipped = await request(refreshRoute, admin, "POST", { ...refreshRequest, companyIds: [fixture.companyId, "cmp_place_not_active"] });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.data));
    assert.equal(skipped.data.collectionExecuted, false);
    assert.deepEqual(skipped.data.results.map(row => [row.companyId, row.status, row.errorCode]),
      [[fixture.companyId, "skipped", "SAVED_RECOVERY_NOT_FOUND"], ["cmp_place_not_active", "failed", "company_not_found"]]);
    assert.deepEqual(skipped.data.counts, { skipped: 1, failed: 1 }, "one failed company cannot suppress other scoped outcomes");
    const legacySourceBefore = await fs.readFile(path.join(legacy.directory, legacy.details));
    const legacyRecovery = await request(recoveryRoute, admin, "POST", { confirm: "recover-saved-products", month: "2026-09", companyIds: [legacy.companyId] });
    assert.equal(legacyRecovery.status, 200, JSON.stringify(legacyRecovery.data));
    assert.equal(legacyRecovery.data.receipts.length, 1, JSON.stringify(legacyRecovery.data));
    const legacyRefresh = await request(refreshRoute, admin, "POST", { ...refreshRequest, month: "2026-09", companyIds: [legacy.companyId, fixture.companyId] });
    assert.equal(legacyRefresh.status, 200, JSON.stringify(legacyRefresh.data));
    const ready = legacyRefresh.data.results[0];
    assert.equal(ready.status, "ready", JSON.stringify(ready)); assert.equal(ready.month, "2026-09");
    assert.equal(ready.quality.recoveredCompanyDays, 2); assert.equal(ready.summary.lodging.coveredCompanyDays, 2);
    assert.equal(ready.summary.lodging.sold, 5); assert.equal(ready.summary.lodging.estimatedRevenue, 500000);
    assert.equal(legacyRefresh.data.results[1].status, "skipped");
    assert.equal(typeof ready.sourceRevision, "string"); assert.ok(["queued", "processing", "idle"].includes(ready.backgroundStatus));
    assert.deepEqual(await fs.readFile(path.join(legacy.directory, legacy.details)), legacySourceBefore, "successful real-receipt publication never changes source products");
    const legacyMonthFile = path.join(dataDir, "company_integrated", require("node:crypto").createHash("sha256").update(legacy.companyId).digest("hex"), "2026-09.json");
    const lastGood = await fs.readFile(legacyMonthFile);
    const changedProducts = JSON.parse(legacySourceBefore); changedProducts[0].price += 1;
    await fs.writeFile(path.join(legacy.directory, legacy.details), JSON.stringify(changedProducts));
    try {
      const held = await request(refreshRoute, admin, "POST", { ...refreshRequest, month: "2026-09", companyIds: [legacy.companyId, fixture.companyId] });
      assert.equal(held.status, 200, JSON.stringify(held.data));
      assert.equal(held.data.results[0].status, "failed");
      assert.equal(held.data.results[0].errorCode, "MONTHLY_SOURCE_UNAVAILABLE", "the standard source adapter retains its safe public error boundary");
      assert.equal(held.data.results[1].status, "skipped", "a corrupted company's source does not abort the remaining batch");
      assert.deepEqual(await fs.readFile(legacyMonthFile), lastGood, "the API preserves the last valid persisted month on a source SHA failure");
    } finally { await fs.writeFile(path.join(legacy.directory, legacy.details), legacySourceBefore); }
    let integrated;
    for (let i = 0; i < 120; i++) {
      integrated = await request(url, admin);
      assert.equal(integrated.status, 200, JSON.stringify(integrated.data));
      if (integrated.data.status === "ready") break;
      if (integrated.data.status === "failed") throw new Error(JSON.stringify(integrated.data));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(integrated.data.status, "ready", output);
    assert.deepEqual(integrated.data.months.map(row => row.month).sort(), ["2026-07", "2026-08"]);
    assert.equal(integrated.data.roomBasis.capacity, 10);
    assert.equal(integrated.data.roomBasis.source, "db_review");
    assert.equal(integrated.data.keywords.length, 2);
    const preview = await request("/api/monthly-reports/preview", admin, "POST", { type: "company", targetId: fixture.companyId, month: "2026-08", cutoffDate: "2026-08-31" });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.deepEqual(integrated.data.snapshot.summary, preview.data.summary, "all customer/monthly amounts share one engine");
    assert.deepEqual(integrated.data.snapshot.sources.observations, preview.data.sources.observations);
    assert.equal((await request(url.replace("2026-08", "2026-13"), admin)).status, 400);
    assert.equal((await request(url.replace(fixture.companyId, "unknown-company"), admin)).status, 404);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "history", "observations.jsonl")), originalHistory);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "company_master", "companies.json")), originalMaster);
    // Existing reviewed-value edit must enqueue derived data automatically.
    const correction = await request("/api/company-master/manual-correction", admin, "POST", { companyId: fixture.companyId, lodgingBasisTotal: 11, expectedRevision: 0 });
    assert.equal(correction.status, 200, JSON.stringify(correction.data));
    let updated;
    for (let i = 0; i < 120; i++) {
      updated = await request(url, admin);
      if (updated.data.status === "ready" && updated.data.roomBasis.capacity === 11) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(updated.data.roomBasis.capacity, 11);
    assert.equal(updated.data.status, "ready");
    assert.notEqual(updated.data.calculatedAt, integrated.data.calculatedAt);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "history", "observations.jsonl")), originalHistory, "recalculation leaves raw history untouched");
    console.log("Company integration API: automatic historical build, scoped saved-product recovery/refresh auth/same-origin/no-network, bounded mixed outcomes, exact monthly parity, correction refresh and raw preservation passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
