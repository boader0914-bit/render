"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

async function seedNormalResponse(dataDir) {
  const companyId = "cmp_place_1201111111", runId = "pocheon_glamping_20260901_090000", collectedAt = "2026-09-01T00:05:00.000Z";
  const directory = path.join(dataDir, "outputs", runId), details = "details/1201111111_weekly_product_details_fixture.json";
  const product = (date, bizItemId, name, saleType, stock, bookingCount, price) => ({ date, bizItemId, name, saleType,
    bizItemSubType: saleType === "숙박" ? "ACCOMMODATION_NIGHT" : "ACCOMMODATION_DAY_USE",
    listType: "객실 종류별 리스트", stock, bookingCount, occupiedBookingCount: 0, price, open: true });
  const products = [
    product("2026-09-01", "normal_a", "숙박 A", "숙박", 5, 0, 100000),
    product("2026-09-01", "normal_b", "숙박 B", "숙박", 5, 0, 200000),
    product("2026-09-01", "normal_l", "피크닉 런치 11~15시", "데이유즈", 2, 0, 50000),
    product("2026-09-01", "normal_d", "피크닉 디너 16~21시", "데이유즈", 2, 0, 60000),
    product("2026-09-02", "normal_a", "숙박 A", "숙박", 2, 2, 100000),
    product("2026-09-02", "normal_b", "숙박 B", "숙박", 4, 1, 200000),
    product("2026-09-02", "normal_l", "피크닉 런치 11~15시", "데이유즈", 2, 1, 50000),
    product("2026-09-02", "normal_d", "피크닉 디너 16~21시", "데이유즈", 2, 1, 60000)
  ];
  const manifest = { id: runId, runId, keyword: "포천글램핑", collectedAt, completedAt: collectedAt,
    checkIn: "2026-09-01", checkOut: "2026-09-02", bookingRangeDays: 2, searchMode: "keyword", collectionMode: "precision",
    collectionPurpose: "revenue_detail", collectionQuality: { status: "complete" }, counts: { overall: 1 },
    fileRoles: { overall: "포천글램핑_네이버전체순위.csv" }, detailJsonFiles: [{ field: "weekly_product_details", name: "[모의] 정상 원본 업체",
      placeId: "1201111111", bookingBusinessId: "1202222222", file: details, itemCount: products.length }] };
  const row = { place_id: "1201111111", bookingBusinessId: "1202222222", "업체명": "[모의] 정상 원본 업체", overall_rank: 1,
    "네이버예약URL": "https://booking.naver.com/booking/3/bizes/1202222222", "숙박상품수": 2, "데이유즈상품수": 2,
    "예약계산대상상품수": 2, "네이버요일별상품상세JSON": `@json-file:${details}` };
  const columns = Object.keys(row), cell = value => `"${String(value).replace(/"/g, '""')}"`;
  await fs.mkdir(path.join(directory, "details"), { recursive: true });
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, details), JSON.stringify(products));
  await fs.writeFile(path.join(directory, manifest.fileRoles.overall), columns.map(cell).join(",") + "\r\n" + columns.map(key => cell(row[key])).join(",") + "\r\n");
  const masterFile = path.join(dataDir, "company_master", "companies.json"), master = JSON.parse(await fs.readFile(masterFile, "utf8"));
  const company = { companyId, primaryName: "[모의] 정상 원본 업체", addresses: ["경기도 포천시 모의 주소"], regions: ["포천"],
    placeIds: ["1201111111"], bookingBusinessIds: ["1202222222"], manualCorrection: { active: true, lodgingBasisTotal: 10, revision: 7 },
    keywords: { "포천글램핑": { keyword: "포천글램핑", runs: [{ runId, collectedAt, rank: 1 }] } }, inventory: {} };
  master.companies[companyId] = company;
  master.companies.cmp_place_deleted_fixture = { ...company, companyId: "cmp_place_deleted_fixture", placeIds: ["deleted-fixture"], deletedAt: collectedAt };
  master.companies.cmp_place_merged_fixture = { ...company, companyId: "cmp_place_merged_fixture", placeIds: ["merged-fixture"], mergedIntoCompanyId: companyId };
  await fs.writeFile(masterFile, JSON.stringify(master));
  return { companyId, runId, sourceFiles: [path.join(directory, "manifest.json"), path.join(directory, details), path.join(directory, manifest.fileRoles.overall)] };
}

async function main() {
  const root = path.resolve(__dirname, ".."), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-saved-month-recalculation-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir), normal = await seedNormalResponse(dataDir);
  const publishedId = "mr_" + crypto.randomUUID(), publishedFile = path.join(dataDir, "monthly_reports", publishedId + ".json");
  const issuedSnapshot = { request: { type: "company", targetId: normal.companyId, month: "2026-09", cutoffDate: "2026-09-30" },
    target: { type: "company", id: normal.companyId }, summary: { lodging: { estimatedRevenue: 123456 } } };
  await fs.mkdir(path.dirname(publishedFile), { recursive: true });
  await fs.writeFile(publishedFile, JSON.stringify({ schemaVersion: 1, id: publishedId, status: "published", snapshot: issuedSnapshot,
    snapshotHash: crypto.createHash("sha256").update(JSON.stringify(issuedSnapshot)).digest("hex") }));
  const preserved = [path.join(dataDir, "history", "observations.jsonl"), path.join(dataDir, "company_master", "companies.json"),
    publishedFile, ...normal.sourceFiles, ...fixture.runIds.map(id => path.join(dataDir, "outputs", id, "manifest.json"))];
  const originalBytes = new Map(await Promise.all(preserved.map(async file => [file, await fs.readFile(file)])));
  const auditFile = path.join(dataDir, "local-audit.json"), preload = path.join(dataDir, "no-network.cjs");
  await fs.writeFile(preload, `
    const fs = require('node:fs'), audit = { externalRequests: 0, childStarts: 0, recalculations: [] };
    const save = () => fs.writeFileSync(${JSON.stringify(auditFile)}, JSON.stringify(audit)); save();
    global.fetch = async () => { audit.externalRequests++; save(); throw new Error('External requests forbidden'); };
    require('node:child_process').spawn = () => { audit.childStarts++; save(); throw new Error('Child processes forbidden'); };
    const integrated = require(${JSON.stringify(path.join(root, "scripts/lib/company_integrated_db.cjs"))});
    const originalCreate = integrated.createCompanyIntegratedDb;
    integrated.createCompanyIntegratedDb = options => {
      const service = originalCreate(options), refresh = service.refreshMonth;
      service.refreshMonth = async (companyId, options) => {
        audit.recalculations.push({ companyId, month: options.month }); save();
        if (companyId === 'cmp_place_monthly_b') throw Object.assign(new Error('/private/path secret-token'), { code: 'TEST_RECALCULATION_FAILURE' });
        return refresh(companyId, options);
      };
      return service;
    };
  `);
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, route = "/api/company-master/recalculate-saved-month";
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "recalculation-admin", GLAMPING_ADMIN_PASSWORD: "recalculation-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "recalculation-member", GLAMPING_B2B_PASSWORD: "recalculation-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(url, cookie = "", method = "GET", body, origin = base) {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => {
    const result = await request("/api/login", "", "POST", { username, password: "recalculation-test-password" });
    assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0];
  };
  const valid = { confirm: "recalculate-saved-month", month: "2026-09", companyIds: [normal.companyId] };
  try {
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await request(route, "", "POST", valid)).status, 401);
    assert.equal((await request(route, await login("recalculation-member"), "POST", valid)).status, 403);
    const admin = await login("recalculation-admin");
    for (const invalid of [null, [], { ...valid, confirm: undefined }, { ...valid, month: "202609" }, { ...valid, month: "2026-13" },
      { ...valid, companyIds: [] }, { ...valid, companyIds: [normal.companyId, normal.companyId] }, { ...valid, companyIds: ["../escape"] },
      { ...valid, companyIds: Array.from({ length: 11 }, (_, i) => `cmp_place_limit_${i}`) }, { ...valid, rawRows: [] }]) {
      assert.equal((await request(route, admin, "POST", invalid)).status, 400);
    }
    for (const origin of ["https://foreign.invalid", "null", "malformed-origin", null, `https://127.0.0.1:${port}`]) {
      assert.equal((await request(route, admin, "POST", valid, origin)).status, 403);
    }
    assert.equal((await fetch(base + route, { method: "POST", headers: { Cookie: admin, Origin: base, "Content-Type": "text/plain" }, body: JSON.stringify(valid) })).status, 415);
    assert.equal((await fetch(base + route, { method: "POST", headers: { Cookie: admin, Origin: base, "Content-Type": "application/json" }, body: "{" })).status, 400);
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile, "utf8")).recalculations, [], "Unauthorized, invalid or cross-origin bodies cannot start a calculation");
    const batch = [normal.companyId, "cmp_place_monthly_b", "cmp_place_not_active", "cmp_place_deleted_fixture", "cmp_place_merged_fixture", fixture.companyId];
    const result = await request(route, admin, "POST", { ...valid, companyIds: batch });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.collectionExecuted, false);
    assert.deepEqual(result.data.counts, { ready: 2, failed: 4 });
    assert.deepEqual(result.data.results.map(value => [value.companyId, value.status]), batch.map((id, i) => [id, [0, 5].includes(i) ? "ready" : "failed"]));
    assert.equal(result.data.results[1].errorCode, "TEST_RECALCULATION_FAILURE");
    assert.ok(result.data.results.slice(2, 5).every(value => value.errorCode === "company_not_found"));
    assert.doesNotMatch(JSON.stringify(result.data), /secret-token|private\/path/);
    const ready = result.data.results[0];
    assert.equal(ready.summary.lodging.sold, 6);
    assert.equal(ready.summary.lodging.estimatedRevenue, 775000);
    assert.equal(ready.summary.lodging.sharedDayUseExcluded, 1);
    assert.equal(typeof ready.sourceRevision, "string");
    assert.match(ready.calculationVersion, /product-max-room-reuse/);
    const stored = await request(`/api/company-master/integrated?companyId=${normal.companyId}&month=2026-09`, admin);
    assert.equal(stored.status, 200, JSON.stringify(stored.data));
    assert.deepEqual(stored.data.snapshot.summary, ready.summary);
    const secondDate = stored.data.snapshot.sources.observations.find(row => row.date === "2026-09-02" && row.productType === "lodging");
    assert.equal(secondDate.inventoryEvidenceVersion, 5);
    assert.equal(secondDate.phoneAllocatedBookings, 3);
    assert.equal(secondDate.phoneAllocatedRevenue, 375000);
    assert.equal(secondDate.sharedDayUseEvidence.physicalRoomBookings, 1);
    const receiptsDirectory = path.join(dataDir, "history", "saved_product_recoveries", crypto.createHash("sha256").update(normal.companyId).digest("hex"));
    assert.equal(await fs.stat(receiptsDirectory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false,
      "A complete normal source can be recalculated without any recovery receipt or relabeling");
    const audit = JSON.parse(await fs.readFile(auditFile, "utf8"));
    assert.deepEqual(audit.recalculations, [normal.companyId, "cmp_place_monthly_b", fixture.companyId].map(companyId => ({ companyId, month: "2026-09" })));
    assert.equal(audit.externalRequests, 0); assert.equal(audit.childStarts, 0);
    for (const [file, bytes] of originalBytes) assert.deepEqual(await fs.readFile(file), bytes, "Saved source, manual review, raw history and published report bytes stay intact");
    console.log("Saved-month recalculation API: normal receipt-free source, room reuse/allocation, admin+CSRF+strict scope, sequential mixed outcomes, exact readback, raw/manual/issued preservation and zero network/collector execution passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
