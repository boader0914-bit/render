"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

async function inventory(dir, prefix = "") {
  const result = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(result, await inventory(file, relative));
    else { const stat = await fs.stat(file); result[relative] = { mtime: stat.mtimeMs, hash: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") }; }
  }
  return result;
}
async function main() {
  const root = path.resolve(__dirname, "..");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "collection-history-api-"));
  const dataDir = path.join(temporary, "data"); await fs.mkdir(dataDir);
  const preload = path.join(temporary, "forbid-network.cjs");
  await fs.writeFile(preload, "global.fetch=async()=>{console.error('UNEXPECTED_EXTERNAL_FETCH');throw new Error('External request forbidden')};\n");
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts", "glamping_app_server.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
    RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
    GLAMPING_ADMIN_USER: "history-admin", GLAMPING_ADMIN_PASSWORD: "history-local-test-password", GLAMPING_B2B_ENABLED: "1", GLAMPING_B2B_USER: "history-member", GLAMPING_B2B_PASSWORD: "history-local-test-password",
    TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "", COLLECTOR_WORKER_ENABLED: "0"
  } });
  let output = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function api(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json", Origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); return { status: response.status, response, value };
  }
  async function login(username) { const result = await api("/api/login", "", "POST", { username, password: "history-local-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; }
  async function write(relative, value) { const file = path.join(dataDir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server failed: ${output}`);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "local server ready");
    assert.equal((await api("/api/collection-history")).status, 401);
    const member = await login("history-member"); assert.equal((await api("/api/collection-history", member)).status, 403);
    const admin = await login("history-admin");
    await new Promise(resolve => setTimeout(resolve, 200));
    // Create a pending receipt after startup initialization. The new history
    // GET must not mark it interrupted as the old requests GET would do.
    await write("history/collector-requests/pending_9999.json", { version: 1, requestId: "pending_9999", workerKey: "manual", trigger: "manual", keyword: "경남글램핑", status: "pending", createdAt: "2026-09-20T03:00:00Z", result: null, finishedAt: null });
    for (let index = 0; index < 60; index++) await write(`history/collector-requests/receipt_${String(index).padStart(4, "0")}.json`, { version: 1, requestId: `receipt_${String(index).padStart(4, "0")}`, workerKey: "manual", trigger: "manual", keyword: "경남글램핑", status: "complete", createdAt: "2026-09-20T03:00:00Z", result: { runId: `stored_${index}`, collectionQuality: { status: "complete", reason: "manifest_checks_passed" } }, message: "SECRET_MESSAGE", token: "SECRET_TOKEN" });
    await write("history/daily_keyword_collection_state.json", { version: 1, days: { "2026-09-21": { day: "2026-09-21", createdAt: "2026-09-21T03:00:00Z", items: [{ keyword: "포천글램핑", status: "completed", runId: "legacy_run", startedAt: "2026-09-21T05:00:00Z", quality: { status: "complete" } }] } } });
    await write("outputs/fallback_run/manifest.json", { keyword: "가평글램핑", completedAt: "2026-08-20T03:00:00Z", collectionQuality: { status: "complete" }, outputDir: "SECRET_PATH", collectorRunToken: "SECRET_RUN_TOKEN" });
    const before = await inventory(dataDir);
    const summary = await api("/api/collection-history?from=2026-08-01&to=2026-09-30", admin);
    assert.equal(summary.status, 200); assert.equal(summary.value.summary.total, 63); assert.equal(summary.value.rows, undefined);
    assert.deepEqual(summary.value.groups.map(group => [group.key, group.count]), [["2026-09", 62], ["2026-08", 1]]);
    const query = "/api/collection-history?from=2026-09-01&to=2026-09-30&groupKey=2026-09";
    const first = await api(query, admin), second = await api(query + "&offset=50", admin);
    assert.equal(first.value.rows.length, 50); assert.equal(second.value.rows.length, 12); assert.equal(first.value.hasMore, true); assert.equal(second.value.hasMore, false);
    const pending = await api(query + "&state=pending", admin); assert.equal(pending.value.rows[0].status, "pending");
    const week = await api("/api/collection-history?from=2026-09-20&to=2026-09-21&groupBy=week", admin);
    assert.deepEqual([week.value.from, week.value.to], ["2026-09-14", "2026-09-27"]);
    for (const params of ["from=2026-02-30", "groupBy=month&groupKey=../../outputs", "limit=51", "worker=admin", "from=2000-01-01&to=2099-12-31"]) assert.equal((await api(`/api/collection-history?${params}`, admin)).status, 400);
    assert.equal((await api("/api/collection-history", admin, "POST", {})).status, 405);
    assert.doesNotMatch(JSON.stringify([summary.value, first.value, second.value]), /SECRET_/);
    assert.deepEqual(await inventory(dataDir), before, "history API preserves all original files, pending state, configuration and DB");
    assert.doesNotMatch(output, /UNEXPECTED_EXTERNAL_FETCH/);
    console.log("Collection history API: auth, 63 historical records, paging, KST weekly scope, safe fields, no writes and no external requests passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
