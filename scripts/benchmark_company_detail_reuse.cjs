"use strict";

// Synthetic LOCAL benchmark: these are generated fixtures, never production
// observations or evidence that a production 2-second target has been met.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), net = require("node:net");
const { spawn } = require("node:child_process"), { once } = require("node:events"), assert = require("node:assert/strict");
const { makeCompanyBootstrapMaster } = require("./fixtures/company_bootstrap_fixture.cjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const semantic = data => { const copy = JSON.parse(JSON.stringify(data)); if (copy.salesHistory) delete copy.salesHistory.generatedAt; return sha(JSON.stringify(copy)); };
const metrics = data => {
  const daily = data.daily || [], sum = field => { const rows = daily.map(row => row[field]).filter(value => typeof value === "number" && Number.isFinite(value)); return rows.length ? rows.reduce((a, b) => a + b, 0) : null; };
  return { capacity: data.capacityBasis?.count ?? null, products: data.products?.length ?? null, days: daily.length, totalRoomObservations: sum("total"),
    publicBookings: sum("publicBookings"), phoneBookings: sum("phoneBookings"), estimatedRevenue: sum("estimatedRevenue"), incompleteDays: daily.filter(row => row.missing || row.partial).length };
};

async function main() {
  const repo = path.resolve(__dirname, ".."), directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-company-detail-")), originals = new Map();
  const master = makeCompanyBootstrapMaster(2, { evidenceRows: 0 }), companyId = "cmp_place_bootstrap_0", selected = master.companies[companyId], runIds = [];
  const saveSource = async (name, text) => { const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); originals.set(file, sha(text)); };
  const cell = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  for (let run = 1; run <= 20; run++) {
    const day = String(run).padStart(2, "0"), runId = "synthetic_glamping_202610" + day + "_090000", products = [];
    runIds.push(runId);
    for (let date = 1; date <= 31; date++) for (let room = 1; room <= 16; room++) {
      const available = (room + date + run) % 5 === 0 ? 0 : 1;
      products.push({ date: "2026-10-" + String(date).padStart(2, "0"), bizItemId: "synthetic-room-" + room, name: "모의 객실 " + room,
        saleType: "숙박", stock: available, total: 1, available, bookingCount: 1 - available, occupiedBookingCount: 0, price: 100000 + room * 1000 });
    }
    const rows = [{ placeId: selected.placeIds[0], bookingBusinessId: selected.bookingBusinessIds[0], name: selected.primaryName,
      "업체명": selected.primaryName, "주소": selected.addresses[0], "네이버원시전체재고": "16", "숙박상품수": "16", "전체객실수": "16",
      "itemDetails": JSON.stringify(products.filter(row => row.date === "2026-10-01")), weeklyProductDetails: "@json-file:products.json",
      dayUseMode: "presence", dayUsePresence: "absent", dayUseScheduleStatus: "no_day_use_product" }];
    const columns = Object.keys(rows[0]), csv = columns.map(cell).join(",") + "\n" + rows.map(row => columns.map(key => cell(row[key])).join(",")).join("\n") + "\n";
    await saveSource("outputs/" + runId + "/products.json", JSON.stringify(products));
    await saveSource("outputs/" + runId + "/fixture_overall_place_rank.csv", csv);
    await saveSource("outputs/" + runId + "/manifest.json", JSON.stringify({ keyword: "모의글램핑", collectedAt: "2026-10-" + day + "T00:00:00.000Z",
      completedAt: "2026-10-" + day + "T00:00:00.000Z", checkIn: "2026-10-01", checkOut: "2026-10-02", adults: 2, productMode: "all",
      searchMode: "keyword", bookingRangeDays: 31, collectionPurpose: "revenue_detail", collectionQuality: { status: "complete" },
      files: ["manifest.json", "fixture_overall_place_rank.csv", "products.json"] }));
  }
  for (const [index, company] of Object.values(master.companies).entries()) {
    company.runIds = [...runIds]; company.firstRunId = runIds[0]; company.lastRunId = runIds.at(-1);
    company.keywords = { regional: { keyword: "모의글램핑", keywordKey: "모의글램핑", runs: runIds.map((runId, i) => ({ runId, rank: index ? 3 : 1, collectedAt: "2026-10-" + String(i + 1).padStart(2, "0") + "T00:00:00.000Z" })) } };
  }
  selected.inventory = { latest: { runId: runIds.at(-1), collectedAt: "2026-10-20T00:00:00.000Z", inventoryEvidenceVersion: 1, stockBasis: { lodgingMaxTotal: 16 } }, snapshots: [] };
  await saveSource("company_master/companies.json", JSON.stringify(master));
  const observations = runIds.flatMap((runId, run) => Array.from({ length: 31 }, (_, i) => ({ observationId: runId + ":" + i, companyKey: companyId, companyName: selected.primaryName,
    runId, collectedAt: "2026-10-" + String(run + 1).padStart(2, "0") + "T00:00:00.000Z", stayDate: "2026-10-" + String(i + 1).padStart(2, "0"),
    productType: "lodging", total: 16, available: 13, sold: 3, estimatedRevenue: 330000 })));
  await saveSource("history/observations.jsonl", observations.map(row => JSON.stringify(row)).join("\n") + "\n");
  let app;
  async function stop() {
    if (!app) return null;
    const child = app.child; await pause(120);
    let memory = null; try { memory = JSON.parse(await fs.readFile(app.memoryFile, "utf8")); } catch {}
    if (!app.exited) child.kill("SIGTERM");
    await Promise.race([app.exit, pause(3000)]);
    if (!app.exited) { child.kill("SIGKILL"); await app.exit; }
    app = null; return memory;
  }
  async function start(ordinal) {
    const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening"); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const memoryFile = path.join(directory, "memory-" + ordinal + ".json"), preload = path.join(directory, "preload.cjs");
    await fs.writeFile(preload, `const fs=require('node:fs'), http=require('node:http'), https=require('node:https');
      const report={synthetic:true,samples:0,externalRequests:0,peakRssBytes:0,peakHeapUsedBytes:0,peakExternalBytes:0,maxRssKiB:0};
      const sample=()=>{const m=process.memoryUsage();report.samples++;report.peakRssBytes=Math.max(report.peakRssBytes,m.rss);report.peakHeapUsedBytes=Math.max(report.peakHeapUsedBytes,m.heapUsed);report.peakExternalBytes=Math.max(report.peakExternalBytes,m.external);report.maxRssKiB=process.resourceUsage().maxRSS;fs.writeFileSync(${JSON.stringify(memoryFile)},JSON.stringify(report));};
      const deny=()=>{report.externalRequests++;sample();throw new Error('Synthetic benchmark forbids external requests');}; global.fetch=deny; https.request=deny;https.get=deny;const request=http.request;http.request=function(...args){const target=args[0],host=typeof target==='string'?new URL(target).hostname:target?.hostname||target?.host; if(!['127.0.0.1','localhost'].includes(host))return deny();return request.apply(this,args);};sample();setInterval(sample,100).unref();process.on('exit',()=>{try{sample();}catch{}});`);
    const allowed = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "NODE_PATH"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(process.execPath, ["--max-old-space-size=512", "--require", preload, path.join(repo, "scripts/glamping_app_server.cjs")], {
      cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...allowed, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory,
        OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"), RENDER: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", GLAMPING_ADMIN_USER: "synthetic-admin", GLAMPING_ADMIN_PASSWORD: "synthetic-local-only" } });
    app = { child, memoryFile, base: "http://127.0.0.1:" + port, exited: false, output: "" }; const entry = app;
    entry.exit = new Promise(resolve => child.once("exit", () => { entry.exited = true; resolve(); }));
    child.stdout.on("data", value => { entry.output = (entry.output + value).slice(-32000); }); child.stderr.on("data", value => { entry.output = (entry.output + value).slice(-32000); });
    let ready = false; for (let i = 0; i < 1200; i++) { if (entry.exited) throw new Error("Synthetic child exited: " + entry.output.slice(-3000)); try { if ((await fetch(entry.base + "/api/health")).ok) { ready = true; break; } } catch {} await pause(25); }
    assert.equal(ready, true, "synthetic app startup timed out");
    const login = await fetch(entry.base + "/api/login", { method: "POST", headers: { "content-type": "application/json", origin: entry.base }, body: JSON.stringify({ username: "synthetic-admin", password: "synthetic-local-only" }) });
    assert.equal(login.status, 200); entry.cookie = login.headers.get("set-cookie").split(";")[0];
    entry.get = async () => { const started = performance.now(), response = await fetch(entry.base + "/api/company-master/detail?companyId=" + companyId, { headers: { cookie: entry.cookie }, signal: AbortSignal.timeout(90000) }), data = await response.json();
      return { status: response.status, data, elapsedMs: +(performance.now() - started).toFixed(3), cacheStatus: response.headers.get("x-company-detail-cache"), serverTiming: response.headers.get("server-timing") }; };
    return entry;
  }
  try {
    const beforeBytes = (await Promise.all([...originals.keys()].map(async file => (await fs.stat(file)).size))).reduce((a, b) => a + b, 0);
    await start(1); const prepareStarted = performance.now(); let cold;
    for (let i = 0; i < 1200; i++) { cold = await app.get(); if (cold.status !== 503 || cold.data.errorCode !== "COMPANY_DETAIL_SOURCE_INDEX_PREPARING") break; await pause(25); }
    const preparationAndColdMs = +(performance.now() - prepareStarted).toFixed(3); assert.equal(cold.status, 200, JSON.stringify(cold.data));
    const repeat = await app.get(); assert.equal(repeat.status, 200); assert.equal(semantic(repeat.data), semantic(cold.data));
    const firstMemory = await stop();
    const finalDirectory = path.join(directory, "company_master", "detail_read_models"); for (const name of await fs.readdir(finalDirectory)) if (name.endsWith(".json")) await fs.unlink(path.join(finalDirectory, name));
    await start(2); let reused; const reuseStarted = performance.now();
    for (let i = 0; i < 1200; i++) { reused = await app.get(); if (reused.status !== 503 || reused.data.errorCode !== "COMPANY_DETAIL_SOURCE_INDEX_PREPARING") break; await pause(25); }
    const preparationAndReuseMs = +(performance.now() - reuseStarted).toFixed(3); assert.equal(reused.status, 200, JSON.stringify(reused.data)); assert.equal(semantic(reused.data), semantic(cold.data));
    assert.deepEqual(metrics(reused.data), metrics(cold.data)); assert.equal(metrics(cold.data).capacity, 16); assert.equal(metrics(cold.data).days, 31); assert.equal(metrics(cold.data).products, 16);
    const secondMemory = await stop();
    for (const [file, digest] of originals) assert.equal(sha(await fs.readFile(file)), digest, "Synthetic authoritative input changed");
    assert.equal(firstMemory.externalRequests, 0); assert.equal(secondMemory.externalRequests, 0);
    const result = { synthetic: true, productionPerformanceVerified: false, fixture: { runs: 20, stayDaysPerRun: 31, roomProducts: 16, historyRows: observations.length, authoritativeFiles: originals.size, bytes: beforeBytes },
      preparationAndColdMs, cold: { elapsedMs: cold.elapsedMs, cacheStatus: cold.cacheStatus, serverTiming: cold.serverTiming }, repeat: { elapsedMs: repeat.elapsedMs, cacheStatus: repeat.cacheStatus, serverTiming: repeat.serverTiming },
      preparationAndReuseMs, restartRunProjectionReuse: { elapsedMs: reused.elapsedMs, cacheStatus: reused.cacheStatus, serverTiming: reused.serverTiming }, firstMemory, secondMemory,
      semanticResponseSha256: semantic(cold.data), semanticParity: true, metricParity: true, metrics: metrics(cold.data), originalsPreserved: true };
    const destination = process.argv[2]; if (destination) await fs.writeFile(path.resolve(destination), JSON.stringify(result, null, 2), { flag: "wx" });
    console.log(JSON.stringify(result));
  } finally { await stop(); assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
