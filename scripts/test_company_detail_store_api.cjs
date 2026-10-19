"use strict";

// Real application processes, isolated saved inputs and no outbound network.
// Request-scoped instrumentation distinguishes detail reads from independent
// background initialization, so a restart hit cannot hide a whole-master read.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const net = require("node:net"), { once } = require("node:events"), { spawn } = require("node:child_process");
const { makeCompanyBootstrapMaster } = require("./fixtures/company_bootstrap_fixture.cjs");
const nodeSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, ".."), directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-detail-api-"));
  const selectedId = "cmp_place_bootstrap_0", runId = "gyeongnam_glamping_20261001_090000";
  const master = makeCompanyBootstrapMaster(2, { evidenceRows: 5 });
  const selected = master.companies[selectedId];
  for (const [index, company] of Object.values(master.companies).entries()) {
    company.runIds = [runId]; company.lastRunId = runId;
    company.keywords = { regional: { keyword: "경남글램핑", keywordKey: "경남글램핑", runs: [{ runId, rank: index ? 3 : 1, collectedAt: "2026-10-01T00:00:00.000Z" }] } };
  }
  // Exercise actual saved-run product recovery rather than only a master hit.
  selected.inventory = { latest: { runId, collectedAt: "2026-10-01T00:00:00.000Z", inventoryEvidenceVersion: 1, stockBasis: { lodgingMaxTotal: 16 } }, snapshots: [] };
  const masterFile = path.join(directory, "company_master/companies.json"), historyFile = path.join(directory, "history/observations.jsonl"), runDir = path.join(directory, "outputs", runId);
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true }); await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(masterFile, JSON.stringify(master));
  await fs.writeFile(historyFile, JSON.stringify({ observationId: "selected-observation", companyKey: selectedId, companyName: selected.primaryName,
    runId, collectedAt: "2026-10-01T00:00:00.000Z", stayDate: "2026-10-01", productType: "lodging", total: 16, available: 14, sold: 2 }) + "\n");
  const product = { date: "2026-10-01", bizItemId: "selected-room", name: "검수 숙박 상품", saleType: "숙박", stock: 14, total: 16, available: 14, bookingCount: 2, occupiedBookingCount: 0, price: 100000 };
  const rows = [{ placeId: selected.placeIds[0], bookingBusinessId: selected.bookingBusinessIds[0], name: selected.primaryName,
    "업체명": selected.primaryName, "주소": selected.addresses[0], "네이버원시전체재고": "16", "숙박상품수": "1", "예약가능수": "14", "전체객실수": "16",
    "itemDetails": JSON.stringify([product]), weeklyProductDetails: JSON.stringify([product]), dayUseMode: "presence", dayUsePresence: "absent", dayUseScheduleStatus: "no_day_use_product" }];
  const columns = Object.keys(rows[0]), cell = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const csv = columns.map(cell).join(",") + "\n" + rows.map(row => columns.map(key => cell(row[key])).join(",")).join("\n") + "\n";
  const csvFile = path.join(runDir, "fixture_overall_place_rank.csv"); await fs.writeFile(csvFile, csv);
  const manifestFile = path.join(runDir, "manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify({ keyword: "경남글램핑", collectedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:00:00.000Z",
    checkIn: "2026-10-01", checkOut: "2026-10-02", adults: 2, productMode: "all", searchMode: "keyword", bookingRangeDays: 1,
    collectionPurpose: "revenue_detail", collectionQuality: { status: "complete" }, files: ["manifest.json", path.basename(csvFile)] }));
  const inputs = new Map(await Promise.all([masterFile, historyFile, csvFile, manifestFile].map(async file => [file, await fs.readFile(file)])));
  let app = null;
  async function start(ordinal) {
    const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening"); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`, preload = path.join(directory, "preload-" + ordinal + ".cjs"), auditFile = path.join(directory, "audit-" + ordinal + ".json");
    await fs.writeFile(preload, `
      const fs = require('node:fs'), fsp = require('node:fs/promises'), http = require('node:http');
      const { AsyncLocalStorage } = require('node:async_hooks'), scope = new AsyncLocalStorage();
      const audit = { requests: [], external: 0, runSourceReads: 0, runMetadataReads: 0 }, destination = ${JSON.stringify(auditFile)};
      const countRunRead = name => { if(name.startsWith(${JSON.stringify(runDir + path.sep)})) {
        if(name === ${JSON.stringify(manifestFile)}) audit.runMetadataReads++; else audit.runSourceReads++;
      } };
      const save = () => fs.writeFileSync(destination, JSON.stringify(audit)); save();
      global.fetch = async () => { audit.external++; save(); throw new Error('External requests forbidden'); };
      const read = fsp.readFile; fsp.readFile = async function(file, ...args) {
        const row = scope.getStore(), name = String(file);
        if(row && name === ${JSON.stringify(masterFile)}) row.masterReadFile++;
        if(row && name === ${JSON.stringify(historyFile)}) row.historyReadFile++;
        if(row) countRunRead(name);
        return read.call(this, file, ...args);
      };
      const readSync = fs.readFileSync; fs.readFileSync = function(file, ...args) {
        if(scope.getStore()) countRunRead(String(file));
        return readSync.call(this, file, ...args);
      };
      const stream = fs.createReadStream; fs.createReadStream = function(file, ...args) {
        const row = scope.getStore(), name = String(file);
        if(row && name === ${JSON.stringify(masterFile)}) row.masterStreams++;
        if(row && name === ${JSON.stringify(historyFile)}) row.historyStreams++;
        return stream.call(this, file, ...args);
      };
      const list = fsp.readdir; fsp.readdir = async function(file, ...args) {
        const row = scope.getStore(); if(row && String(file) === ${JSON.stringify(path.join(directory, "outputs"))}) row.globalRunLists++;
        return list.call(this, file, ...args);
      };
      const create = http.createServer; http.createServer = function(...args) {
        const index = args.findLastIndex(value => typeof value === 'function'), listener = args[index];
        if(index >= 0) args[index] = function(req, res) {
          if(!req.url.startsWith('/api/company-master/detail?')) return listener.call(this, req, res);
          const row = { masterReadFile:0, historyReadFile:0, masterStreams:0, historyStreams:0, globalRunLists:0 };
          res.once('finish', () => { row.status = res.statusCode; audit.requests.push(row); save(); });
          return scope.run(row, () => listener.call(this, req, res));
        };
        return create.apply(this, args);
      };
    `);
    let output = "";
    const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], { cwd: root, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory,
        OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"), RENDER: "", RENDER_EXTERNAL_URL: "",
        SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local", TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0",
        TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "", GLAMPING_ADMIN_USER: "detail-admin", GLAMPING_ADMIN_PASSWORD: "detail-test-password",
        GLAMPING_B2B_ENABLED: "1", GLAMPING_B2B_USER: "detail-member", GLAMPING_B2B_PASSWORD: "detail-test-password" } });
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    app = { child, base, auditFile, output: () => output };
    let ready = false;
    for (let i = 0; i < 300; i++) { if (child.exitCode !== null) throw new Error(output); try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await nodeSleep(25); }
    assert.equal(ready, true, output);
    app.request = async (route, { cookie = "", method = "GET", body } = {}) => {
      const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json", Origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, headers: response.headers, data: await response.json() };
    };
    app.login = async (username = "detail-admin") => { const r = await app.request("/api/login", { method: "POST", body: { username, password: "detail-test-password" } }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
    return app;
  }
  async function stop() { if (app) { app.child.kill(); if (app.child.exitCode === null) await once(app.child, "exit"); app = null; } }
  try {
    const url = "/api/company-master/detail?companyId=" + selectedId;
    await start(1);
    assert.equal((await app.request(url)).status, 401);
    assert.equal((await app.request("/api/company-master/detail-index-status")).status, 401);
    assert.equal((await app.request("/api/analysis-work-status")).status, 401);
    assert.equal((await app.request(url, { cookie: await app.login("detail-member") })).status, 403);
    const cookie = await app.login(), preparationStarted = performance.now();
    const admissionStatus = await app.request("/api/analysis-work-status", { cookie });
    assert.equal(admissionStatus.status, 200); assert.equal(admissionStatus.data.limits.slots, 1);
    assert.equal(admissionStatus.data.limits.admissionIsEstimate, true);
    let first, firstMs;
    for (let attempt = 0; attempt < 300; attempt++) {
      const started = performance.now(); first = await app.request(url, { cookie }); firstMs = performance.now() - started;
      if (first.status !== 503 || first.data.errorCode !== "COMPANY_DETAIL_SOURCE_INDEX_PREPARING") break;
      await nodeSleep(25);
    }
    const preparationAndFirstMs = performance.now() - preparationStarted;
    assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.headers.get("x-company-detail-cache"), "calculated");
    assert.equal((await app.request("/api/company-master/detail-index-status", { cookie })).data.ready, true);
    assert.match(first.headers.get("server-timing"), /sourceCheck;dur=/);
    assert.equal(first.data.company.companyId, selectedId); assert.equal(first.data.products.length, 1);
    assert.equal(first.data.products[0].name, "검수 숙박 상품"); assert.equal(first.data.daily[0].total, 16);
    assert.equal(first.data.daily[0].publicBookings, 2); assert.equal(first.data.daily[0].estimatedRevenue, 200000);
    assert.equal(first.data.rankTrend.points[0].regionalMedianRank, 2); assert.equal(first.data.rankTrend.points[0].regionalSampleCount, 2);
    const memoryStarted = performance.now(), second = await app.request(url, { cookie }), memoryMs = performance.now() - memoryStarted;
    assert.equal(second.headers.get("x-company-detail-cache"), "memory"); assert.deepEqual(second.data, first.data);
    const originalAudit = JSON.parse(await fs.readFile(app.auditFile, "utf8"));
    const reads = originalAudit.requests.filter(row => row.status === 200);
    assert.deepEqual(reads[0], { masterReadFile: 0, historyReadFile: 0, masterStreams: 0, historyStreams: 0, globalRunLists: 0, status: 200 });
    assert.deepEqual(reads[1], { masterReadFile: 0, historyReadFile: 0, masterStreams: 0, historyStreams: 0, globalRunLists: 0, status: 200 });
    assert.equal(originalAudit.external, 0); await stop();
    await start(2); const afterCookie = await app.login(), restartStarted = performance.now();
    const restarted = await app.request(url, { cookie: afterCookie }), restartMs = performance.now() - restartStarted;
    assert.equal(restarted.status, 200); assert.equal(restarted.headers.get("x-company-detail-cache"), "saved"); assert.deepEqual(restarted.data, first.data);
    const restartAudit = JSON.parse(await fs.readFile(app.auditFile, "utf8"));
    assert.deepEqual(restartAudit.requests[0], { masterReadFile: 0, historyReadFile: 0, masterStreams: 0, historyStreams: 0, globalRunLists: 0, status: 200 });
    assert.equal(restartAudit.external, 0);
    // A missing final detail does not require re-reading CSV/product payloads
    // after a restart: the independently verified company/run projection stays.
    await stop();
    const finalDetailDirectory = path.join(directory, "company_master", "detail_read_models");
    for (const name of await fs.readdir(finalDetailDirectory)) if (name.endsWith(".json")) await fs.unlink(path.join(finalDetailDirectory, name));
    await start(3); const projectionCookie = await app.login(), projectionStarted = performance.now(); let projected;
    for (let attempt = 0; attempt < 300; attempt++) {
      projected = await app.request(url, { cookie: projectionCookie });
      if (projected.status !== 503 || projected.data.errorCode !== "COMPANY_DETAIL_SOURCE_INDEX_PREPARING") break;
      await nodeSleep(25);
    }
    const projectionMs = performance.now() - projectionStarted;
    assert.equal(projected.status, 200, JSON.stringify(projected.data)); assert.equal(projected.headers.get("x-company-detail-cache"), "calculated");
    const comparable = data => { const value = JSON.parse(JSON.stringify(data)); if (value.salesHistory) delete value.salesHistory.generatedAt; return value; };
    assert.deepEqual(comparable(projected.data), comparable(first.data));
    const projectionAudit = JSON.parse(await fs.readFile(app.auditFile, "utf8"));
    assert.equal(originalAudit.runSourceReads > 0, true, "the initial fixture really exercised raw saved-run recovery");
    assert.equal(projectionAudit.runSourceReads, 0, "rebuilding a final detail reuses saved company/run projections without raw run-body reads");
    assert.equal(projectionAudit.external, 0);
    for (const [file, bytes] of inputs) assert.deepEqual(await fs.readFile(file), bytes, "selected detail reads preserve original " + path.basename(file));
    console.log(JSON.stringify({ check: "company_detail_saved_reuse_api", preparationAndFirstMs: +preparationAndFirstMs.toFixed(2), firstMs: +firstMs.toFixed(2), memoryMs: +memoryMs.toFixed(2), restartSavedMs: +restartMs.toFixed(2),
      rawProductRecovery: true, rankBenchmarkParity: true, globalMasterReadFiles: 0, globalHistoryReadFiles: 0, globalOutputListings: 0,
      restartRawBodyReads: 0, runProjectionRebuildMs: +projectionMs.toFixed(2), runProjectionRawBodyReads: projectionAudit.runSourceReads,
      runProjectionMetadataReads: projectionAudit.runMetadataReads,
      runProjectionSemanticParity: true, originalsPreserved: inputs.size, externalRequests: 0 }));
  } finally { await stop(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
