"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

async function inventory(directory, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(files, await inventory(file, relative));
    else if (entry.isFile()) {
      const stat = await fs.stat(file);
      files[relative] = { mtime: stat.mtimeMs, hash: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") };
    }
  }
  return files;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "history-run-api-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs");
  await fs.mkdir(dataDir);
  const preload = path.join(temporary, "forbid-network.cjs");
  await fs.writeFile(preload, `
const forbidden = () => { console.error("UNEXPECTED_EXTERNAL_REQUEST"); throw new Error("External request forbidden"); };
global.fetch = async () => forbidden();
for (const name of ["node:http", "node:https"]) {
  const provider = require(name); provider.request = forbidden; provider.get = forbidden;
}
`);
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "history-view-admin", GLAMPING_ADMIN_PASSWORD: "history-view-local-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "history-view-member", GLAMPING_B2B_PASSWORD: "history-view-local-password", COLLECTOR_WORKER_ENABLED: "0",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      // Nonempty test-only keys make a missed skip flag attempt a trapped call,
      // instead of silently treating the provider as unconfigured.
      KOSIS_API_KEY: "fake-key", NAVER_CLIENT_ID: "fake-client", NAVER_CLIENT_SECRET: "fake-secret",
      NAVER_SEARCHAD_API_KEY: "fake-ad-key", NAVER_SEARCHAD_SECRET_KEY: "fake-ad-secret", NAVER_SEARCHAD_CUSTOMER_ID: "fake-customer"
    }
  });
  let output = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function api(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, response, value };
  }
  async function login(username) {
    const result = await api("/api/login", "", "POST", { username, password: "history-view-local-password" });
    assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0];
  }
  async function write(relative, content) {
    const file = path.join(dataDir, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
  const companyId = "cmp_place_123456";
  async function seedRun(runId, date, bookings, { partial = false, reference = "", unmatched = false } = {}) {
    const product = { name: "모의 객실", bizItemId: "room-1", businessId: unmatched ? "888" : "555", date, stock: 10, bookingCount: bookings, price: 150000, productType: "lodging" };
    const headers = ["place_id", "업체명", "주소", "소재지클러스터", "네이버예약사업자ID", "숙박확인재고수", "숙박예약가능수", "숙박판매완료수", "네이버요일별상품상세JSON", "dayUsePresence", "dayUseScheduleStatus", "네이버예약재고수집상태"];
    const values = [unmatched ? "987654" : "123456", unmatched ? "[모의] 검수 전 글램핑" : "[모의] 저장 글램핑", "경상남도 산청군 모의 주소", "산청", product.businessId, 10, 10 - bookings, bookings, reference || JSON.stringify([product]), "absent", "no_day_use_product", "성공"];
    await write(`outputs/${runId}/rank.csv`, headers.map(csvCell).join(",") + "\n" + values.map(csvCell).join(",") + "\n");
    await write(`outputs/${runId}/manifest.json`, {
      keyword: "경남글램핑", checkIn: date, checkOut: date, adults: 2, productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail",
      bookingRangeDays: 1, detailRankRanges: "1-5", completedAt: `${date}T00:00:00.000Z`, workerKey: "manual", scheduledCollection: true,
      collectionQuality: { status: partial ? "partial" : "complete", reason: partial ? "schedule_responses_failed" : "manifest_checks_passed" },
      counts: { overall: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverScheduleRequested: partial ? 2 : 1,
        naverScheduleSucceeded: 1, naverScheduleFailed: partial ? 1 : 0, naverScheduleBlocked: 0 },
      fileRoles: { overall: "rank.csv" }, files: ["rank.csv"], collectorRunToken: "SECRET_COLLECTOR_TOKEN", outputDir: "SECRET_FILESYSTEM_PATH"
    });
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server failed: ${output}`);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "server ready");
    const oldRun = "gyeongnam_glamping_20260901_090000", newerRun = "gyeongnam_glamping_20261014_090000", sameDayRun = "gyeongnam_glamping_20261014_130000";
    const route = id => `/api/history/runs/${id}`;
    assert.equal((await api(route(oldRun))).status, 401);
    assert.equal((await api(route(oldRun), await login("history-view-member"))).status, 403);
    const admin = await login("history-view-admin");
    // Seed after bootstrap: browsing must not produce a new company/history
    // record, even when this saved run has no accumulated observation yet.
    await new Promise(resolve => setTimeout(resolve, 250));
    await seedRun(oldRun, "2026-09-01", 2);
    await seedRun(newerRun, "2026-10-14", 4, { partial: true });
    await seedRun(sameDayRun, "2026-10-14", 0);
    const unreviewedRun = "unreviewed_glamping_20261014_090000", referencedRun = "referenced_glamping_20261014_090000";
    await seedRun(unreviewedRun, "2026-10-14", 3, { unmatched: true });
    await seedRun(referencedRun, "2026-10-14", 1, { reference: "@json-file:details/products.json" });
    await write(`outputs/${referencedRun}/details/products.json`, [{ name: "모의 객실", bizItemId: "room-1", businessId: "555", date: "2026-10-14", stock: 10, bookingCount: 1, price: 150000, productType: "lodging" }]);
    await write("company_master/companies.json", { companies: {
      [companyId]: { companyId, primaryName: "[모의] 저장 글램핑", placeIds: ["123456"], bookingBusinessIds: ["555"],
        manualCorrection: { active: true, lodgingBasisTotal: 16, updatedAt: "2026-10-14T00:00:00.000Z" }, inventory: {} }
    }, sourceIndex: { "place:123456": companyId } });
    await write("history/observations.jsonl", JSON.stringify({ observationId: "unrelated-existing-observation", runId: "preserved_other_run", keyword: "포천글램핑", keywordKey: "포천글램핑", companyKey: "another-company", productType: "lodging", collectedDate: "2026-09-01", collectedAt: "2026-09-01T00:00:00Z", supply: 5, sold: 0 }) + "\n");
    await write("history/collector-requests/preserved_pending.json", { requestId: "preserved_pending", status: "pending", keyword: "태안글램핑", result: null });
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "manifest.json"), JSON.stringify({ keyword: "SECRET_OUTSIDE_RUN", files: ["rank.csv"] }));
    await fs.writeFile(path.join(outside, "secret.json"), JSON.stringify([{ stock: 999, bookingCount: 999, name: "SECRET_OUTSIDE_FILE" }]));
    await fs.symlink(outside, path.join(outputsDir, "outside_link"), process.platform === "win32" ? "junction" : "dir");
    const linkedRun = "linked_glamping_20261014_090000";
    await seedRun(linkedRun, "2026-10-14", 1, { reference: "@json-file:details/secret.json" });
    await fs.mkdir(path.join(outputsDir, linkedRun, "details"));
    try {
      await fs.symlink(path.join(outside, "secret.json"), path.join(outputsDir, linkedRun, "details", "secret.json"), "file");
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error;
      // Windows without symlink privilege can still exercise rejection at the
      // same nested JSON reference path using a directory junction.
      await fs.symlink(outside, path.join(outputsDir, linkedRun, "details", "secret.json"), "junction");
      console.log("Regular file symlink creation unavailable on this Windows host; nested JSON-path junction tested instead");
    }
    const linkedDirectoryRun = "nested_glamping_20261014_090000";
    await seedRun(linkedDirectoryRun, "2026-10-14", 1, { reference: "@json-file:details/secret.json" });
    await fs.symlink(outside, path.join(outputsDir, linkedDirectoryRun, "details"), process.platform === "win32" ? "junction" : "dir");
    const unsafeManifestRun = "unsafe_manifest_glamping_20261014_090000";
    await write(`outputs/${unsafeManifestRun}/manifest.json`, { keyword: "모의 경로 검증", counts: { overall: 1 }, fileRoles: { overall: "../../../outside/secret.csv" }, files: ["../../../outside/secret.csv"] });
    await fs.writeFile(path.join(outside, "secret.csv"), "place_id,업체명\n666,SECRET_OUTSIDE_CSV\n");
    const before = await inventory(dataDir);
    const catalog = await api("/api/runs", admin);
    assert.equal(catalog.status, 200);
    assert.ok([oldRun, newerRun, sameDayRun].every(id => catalog.value.runs.some(run => run.id === id)), "catalog retains both older and same-day runs");
    const old = await api(route(oldRun), admin), recent = await api(route(newerRun), admin), normalZero = await api(route(sameDayRun), admin);
    for (const result of [old, recent, normalZero]) {
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.equal(result.value.historyView.sourceRunId, result.value.run.id);
      assert.deepEqual(result.value.historyView, { readOnly: true, scope: "saved_run", source: "stored_outputs", sourceRunId: result.value.run.id,
        companyDbMatched: true, companyReviewApplied: true, roomBasis: "stored_observations_with_current_db_review" });
      assert.equal(result.value.history, undefined, "one run is not mislabeled as whole-keyword history");
      assert.equal(result.value.companyMaster, undefined, "browsing does not upsert the company DB");
      assert.equal(result.value.datalabTrend, null);
      assert.equal(result.value.tourismVisitorHistory, null);
      const item = result.value.availability.items[0];
      assert.equal(item.inventoryCapacityBaseline.companyId, companyId);
      assert.equal(item.inventoryCapacityBaseline.lodgingOverride.count, 16, "current reviewed room basis is honored without changing source");
      assert.equal(item.inventoryEvidence.capacityBasis.source, "db_correction");
      assert.equal(item.inventoryEvidence.lodging.rows[0].total, 16);
      assert.doesNotMatch(JSON.stringify(result.value), /SECRET_|collectorRunToken|fake-secret|fake-ad-secret/);
    }
    assert.equal(old.value.run.id, oldRun);
    assert.equal(old.value.availability.items[0].weeklyProductDetails[0].bookingCount, 2);
    assert.equal(recent.value.availability.items[0].weeklyProductDetails[0].bookingCount, 4);
    assert.equal(normalZero.value.availability.items[0].weeklyProductDetails[0].bookingCount, 0, "normal zero remains its own stored observation");
    assert.equal(recent.value.run.collectionQuality.status, "partial");
    assert.equal(recent.value.collectionDiagnostics.counts.naverScheduleFailed, 1, "failed responses retain their reason instead of becoming normal zero");
    assert.equal(normalZero.value.collectionDiagnostics.counts.naverScheduleFailed, 0);
    const unreviewed = await api(route(unreviewedRun), admin);
    assert.equal(unreviewed.status, 200);
    assert.equal(unreviewed.value.historyView.companyDbMatched, false);
    assert.equal(unreviewed.value.historyView.companyReviewApplied, false);
    assert.equal(unreviewed.value.availability.items[0].inventoryEvidence.capacityBasis.count, 10, "another company's DB review cannot override this facility");
    const referenced = await api(route(referencedRun), admin);
    assert.equal(referenced.status, 200);
    assert.equal(referenced.value.availability.items[0].weeklyProductDetails[0].bookingCount, 1, "nested saved JSON remains readable within the selected run");
    const returned = await api(route(oldRun), admin);
    assert.deepEqual({ run: returned.value.run, availability: returned.value.availability, historyView: returned.value.historyView },
      { run: old.value.run, availability: old.value.availability, historyView: old.value.historyView },
      "changing selection and returning preserves the chosen historical result");
    for (const id of ["missing_run", "outside_link", linkedRun, linkedDirectoryRun, "..%5Coutside", "%2Foutside", "..%2Foutside", `${oldRun}%2Frank.csv`, "%E0%A4%A"]) {
      const rejected = await api(route(id), admin);
      assert.equal(rejected.status, 404, id);
      assert.doesNotMatch(JSON.stringify(rejected.value), /SECRET_|outside|[A-Z]:\\|ENOENT|URIError/);
    }
    const unsafe = await api(route(unsafeManifestRun), admin);
    assert.equal(unsafe.status, 200);
    assert.equal(unsafe.value.availability.items.length, 0, "manifest role cannot read a path absent from this run's directory entries");
    assert.doesNotMatch(JSON.stringify(unsafe.value), /SECRET_OUTSIDE_CSV/);
    assert.equal((await api(route(oldRun), admin, "POST", {})).status, 405);
    assert.deepEqual(await inventory(dataDir), before, "all source files, reviewed DB, observations, receipts and configs are unchanged");
    assert.doesNotMatch(output, /UNEXPECTED_EXTERNAL_REQUEST/, "viewing any stored run calls no external provider");
    console.log("History run API: admin auth, older/same-day selection, reviewed-room provenance, zero/error distinction, path and nested link isolation, no writes or external requests passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
