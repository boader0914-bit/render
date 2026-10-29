"use strict";
// Local fixture only. Real crawlers and all outbound provider traffic are denied.
const assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { installFixture } = require("./test_operating_web_integration.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild } = require("./test_collector_integration.cjs");
const root = path.resolve(__dirname, "..");
const admin = { username: "monitor-fixture-admin", password: "monitor-fixture-local-password" };
const member = { username: "monitor-fixture-member", password: "monitor-fixture-member-password" };
async function digestTree(directory) {
  const files = [];
  async function walk(dir) { for (const entry of await fsp.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) await walk(file); else files.push([path.relative(directory, file), crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex")]); } }
  await walk(directory); return files.sort((a, b) => a[0].localeCompare(b[0]));
}
async function main() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-monitor-api-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fsp.mkdir(configDir, { recursive: true }); await fsp.mkdir(outputsDir);
  const attempts = path.join(temporary, "forbidden.log"), events = path.join(temporary, "events.jsonl"), preload = path.join(temporary, "preload.cjs");
  await fsp.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify({ root, attempts, events })});\n`);
  let server; const logs = [];
  try {
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
      MASTER_DB_PATH: path.join(dataDir, "master_db/test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0", COLLECTOR_EXECUTION_MODE: "worker",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_RETIRED_WORKER_KEYS: "scheduled",
      GLAMPING_ADMIN_USER: admin.username, GLAMPING_ADMIN_PASSWORD: admin.password, GLAMPING_B2B_USER: member.username, GLAMPING_B2B_PASSWORD: member.password, GLAMPING_B2B_ENABLED: "1"
    } });
    server.stdout.on("data", chunk => logs.push(String(chunk))); server.stderr.on("data", chunk => logs.push(String(chunk)));
    await waitUntil(async () => { if (server.exitCode !== null) throw Error(logs.join("")); try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "Monitor fixture startup", 15000);
    const adminCookie = await login(base, admin), memberCookie = await login(base, member);
    for (const [cookie, expected] of [["", 401], [memberCookie, 403]]) {
      assert.equal((await request(base, "/api/collection-monitor", cookie)).response.status, expected);
      assert.equal((await request(base, "/api/collection-rotation/daily-limits", cookie, jsonPost({}))).response.status, expected);
    }
    const api = (route, options) => request(base, route, adminCookie, options);
    // Wait for the fixture queue's normal boot initialization, before measuring reads.
    await waitUntil(async () => (await api("/api/collection-monitor")).body.postprocessCoverage.available, "Monitor memory snapshot ready");
    const before = await digestTree(configDir);
    const snapshot = await api("/api/collection-monitor");
    assert.equal(snapshot.response.status, 200); assert.equal(snapshot.body.available, true);
    assert.match(snapshot.response.headers.get("cache-control"), /no-store/);
    assert.equal(snapshot.body.timezone, "Asia/Seoul"); assert.equal(snapshot.body.coverage.actualItems, 0);
    assert.ok(snapshot.body.items.every(item => item.projected === true), "Computed slots are never stored allocations");
    assert.ok(snapshot.body.coverage.days.length === 7);
    for (let i = 0; i < 3; i++) assert.equal((await api("/api/collection-monitor")).response.status, 200);
    for (const query of ["from=2026-10-01&to=2026-10-08", "from=2026-02-30", "workerKey=web"]) assert.equal((await api("/api/collection-monitor?" + query)).response.status, 400);
    assert.equal((await api("/api/collection-monitor", jsonPost({ enabled: true }))).response.status, 405);
    assert.equal((await api("/api/collection-rotation/daily-limits")).response.status, 405);
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({}), method: "PUT" })).response.status, 405);
    assert.equal((await api("/api/collection-rotation/daily-limits", jsonPost({}))).response.status, 403, "An explicit same-origin header is required");
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({}), headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } })).response.status, 403);
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({}), headers: { "Content-Type": "application/json", Origin: base.replace("http:", "https:") } })).response.status, 403);
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({}), headers: { "Content-Type": "application/json", Origin: base + "/path" } })).response.status, 403);
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({}), headers: { "Content-Type": "text/plain", Origin: base } })).response.status, 415);
    assert.equal((await api("/api/collection-rotation/daily-limits", { ...jsonPost({ enabled: true }), headers: { "Content-Type": "application/json", Origin: base } })).response.status, 400, "A narrow daily-limit operation cannot activate a stopped plan");
    const current = await api("/api/collection-rotation");
    const stale = await api("/api/collection-rotation/daily-limits", { ...jsonPost({ expectedRevision: current.body.revision + 100, workers: [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }] }), headers: { "Content-Type": "application/json", Origin: base } });
    assert.equal(stale.response.status, 409, "A stale revision cannot change daily limits");
    assert.deepEqual(await digestTree(configDir), before, "Monitor reads and rejected mutations preserve all config bytes");
    assert.equal(fs.existsSync(events), false, "Monitor never starts a crawler");
    assert.equal(fs.existsSync(attempts), false, "Monitor makes no provider requests");
    for (const asset of ["/collection-monitor.js", "/collection-monitor.css"]) assert.equal((await fetch(base + asset, { headers: { Cookie: adminCookie } })).status, 200);
    console.log("PASS collection monitor HTTP admin guard, bounded range, GET only, no-store, config SHA preservation, zero collection and outbound requests");
  } finally {
    if (server) await stopChild(server);
    const actualTemp = path.resolve(temporary); assert.equal(path.dirname(actualTemp), path.resolve(os.tmpdir())); assert.ok(path.basename(actualTemp).startsWith("collection-monitor-api-"));
    await fsp.rm(actualTemp, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
