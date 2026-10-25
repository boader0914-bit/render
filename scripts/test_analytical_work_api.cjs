"use strict";

// Isolated local HTTP fixture. This starts no collection, worker or provider
// request and checks the public boundary of the read-only pressure diagnostics.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const net = require("node:net"), crypto = require("node:crypto"), { once } = require("node:events"), { spawn } = require("node:child_process");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, ".."), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "analytical-work-api-"));
  const masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.mkdir(path.join(dataDir, "outputs"), { recursive: true });
  await fs.writeFile(masterFile, JSON.stringify({ companies: {} })); await fs.writeFile(historyFile, "");
  const originals = new Map(await Promise.all([masterFile, historyFile].map(async file => [file, await fs.readFile(file)])));
  const preload = path.join(dataDir, "no-provider-network.cjs");
  await fs.writeFile(preload, "global.fetch=async()=>{throw new Error('Provider requests forbidden in analytical-work fixture');};\n");
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, password = "local-only-" + crypto.randomBytes(10).toString("hex");
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "pressure-admin", GLAMPING_ADMIN_PASSWORD: password, GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "pressure-member", GLAMPING_B2B_PASSWORD: password,
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: ""
    }
  });
  let output = "", startError;
  child.on("error", error => { startError = error; });
  const collect = chunk => { output = (output + chunk.toString()).slice(-2 * 1024 * 1024); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  async function request(route, { cookie = "", method = "GET", body } = {}) {
    const response = await fetch(base + route, { method, redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json", origin: base }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  async function login(username) {
    const result = await request("/api/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200); assert.ok(result.response.headers.get("set-cookie"));
    return result.response.headers.get("set-cookie").split(";")[0];
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error("Fixture server exited before readiness: " + output);
      try { if ((await request("/api/health")).status === 200) { ready = true; break; } } catch {}
      await sleep(50);
    }
    assert.equal(ready, true, "isolated server reaches readiness");
    const route = "/api/analytical-work";
    assert.equal((await request(route)).status, 401, "anonymous GET cannot read runtime diagnostics");
    assert.equal((await request(route, { method: "POST", body: {} })).status, 401, "anonymous POST cannot bypass authentication");
    const member = await login("pressure-member"), admin = await login("pressure-admin");
    assert.equal((await request(route, { cookie: member })).status, 403, "member GET cannot read admin diagnostics");
    assert.equal((await request(route, { cookie: member, method: "POST", body: {} })).status, 403);
    const beforeRotation = await request("/api/collection-rotation", { cookie: admin });
    const beforeCollector = await request("/api/collector-status", { cookie: admin });
    const diagnostics = await request(route, { cookie: admin });
    assert.equal(diagnostics.status, 200); assert.deepEqual(Object.keys(diagnostics.data).sort(), ["memory", "monthlyRecalculation", "monthlySources", "observationIndex", "productCapacityVerification", "responsiveness", "savedProductRecovery", "work"]);
    assert.equal(diagnostics.data.responsiveness.enabled, true);
    assert.ok(["monitoring", "unavailable"].includes(diagnostics.data.responsiveness.state));
    assert.ok(Array.isArray(diagnostics.data.responsiveness.history));
    for (const group of ["savedProductRecovery", "productCapacityVerification"])
      for (const [key, value] of Object.entries(diagnostics.data[group])) assert.ok(Number.isSafeInteger(value) && value >= 0, `${group}.${key}`);
    for (const [key, value] of Object.entries(diagnostics.data.monthlyRecalculation)) assert.ok(Number.isSafeInteger(value) && value >= 0, key);
    for (const [key, value] of Object.entries(diagnostics.data.monthlySources)) {
      if (["companyCatalog", "industrySourceCandidates", "companySourceCandidates"].includes(key)) {
        for (const counter of Object.values(value)) assert.ok(Number.isSafeInteger(counter) && counter >= 0);
      } else if (key === "preparedCatalogReadsByScope") {
        assert.deepEqual(Object.keys(value).sort(), ["company", "industry", "keyword", "other", "region"]);
        for (const counter of Object.values(value)) assert.ok(Number.isSafeInteger(counter) && counter >= 0);
      } else assert.ok(Number.isSafeInteger(value) && value >= 0, key);
    }
    assert.equal(typeof diagnostics.data.observationIndex.ready, "boolean");
    for (const value of Object.values(diagnostics.data.observationIndex.stats)) assert.ok(Number.isSafeInteger(value) && value >= 0);
    assert.equal(diagnostics.data.observationIndex.source, undefined, "raw identity/path metadata is not exposed");
    assert.equal(typeof diagnostics.data.work.active, "boolean"); assert.equal(typeof diagnostics.data.work.closed, "boolean");
    for (const key of ["queuedForeground", "queuedBackground"]) assert.ok(Number.isSafeInteger(diagnostics.data.work[key]) && diagnostics.data.work[key] >= 0);
    assert.equal(diagnostics.data.work.memory.enabled, true);
    if (diagnostics.data.memory !== null) {
      assert.equal(diagnostics.data.memory.scope, "live-allocation-and-v8-heap-admission-estimate");
      for (const key of ["rssBytes", "heapUsedBytes", "externalBytes", "estimatedLiveBytes", "limitBytes"]) assert.ok(Number.isFinite(diagnostics.data.memory[key]) && diagnostics.data.memory[key] >= 0, key);
      assert.ok(Number.isFinite(diagnostics.data.memory.liveAllocationRatio) && diagnostics.data.memory.liveAllocationRatio >= 0);
      if (diagnostics.data.memory.heapStatisticsStatus === "available") {
        assert.ok(Number.isSafeInteger(diagnostics.data.memory.heapLimitBytes) && diagnostics.data.memory.heapLimitBytes > 0);
        assert.equal(diagnostics.data.memory.heapRatio, diagnostics.data.memory.heapUsedBytes / diagnostics.data.memory.heapLimitBytes);
        assert.equal(diagnostics.data.memory.ratio, Math.max(diagnostics.data.memory.liveAllocationRatio, diagnostics.data.memory.heapRatio));
      } else {
        assert.equal(diagnostics.data.memory.heapRatio, null); assert.equal(diagnostics.data.memory.heapLimitBytes, null);
        assert.equal(diagnostics.data.memory.ratio, diagnostics.data.memory.liveAllocationRatio);
      }
    }
    assert.equal(JSON.stringify(diagnostics.data).includes(password), false, "runtime diagnostics contain no credentials");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await request(route, { cookie: admin, method, body: { reset: true } })).status, 405, method + " cannot modify pressure or queues");
    }
    for (let index = 0; index < 3; index++) assert.equal((await request(route, { cookie: admin })).status, 200);
    const afterRotation = await request("/api/collection-rotation", { cookie: admin });
    assert.equal(afterRotation.data.enabled, beforeRotation.data.enabled);
    assert.deepEqual(afterRotation.data.config, beforeRotation.data.config, "GET diagnostics and rejected methods cannot modify reservation definitions");
    const afterCollector = await request("/api/collector-status", { cookie: admin });
    const safeWorkerState = data => data.workers.map(row => ({ workerKey: row.workerKey, activeJobId: row.activeJobId, queued: row.queued, halted: row.halted }));
    assert.deepEqual(safeWorkerState(afterCollector.data), safeWorkerState(beforeCollector.data));
    assert.equal((await request("/api/crawl-status", { cookie: admin })).data.active, false);
    for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes, "runtime diagnostics cannot rewrite saved collection inputs");
    console.log("Analytical work API passed: anonymous/member denied, admin read-only GET, modifying methods rejected, source/schedule/worker state preserved.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
    const resolved = path.resolve(dataDir); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("analytical-work-api-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
