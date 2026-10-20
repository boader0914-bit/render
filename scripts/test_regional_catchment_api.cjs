"use strict";
// Isolated full-application QA. All numeric cells below are synthetic and
// clearly labelled; no production file, provider, schedule or key is used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const crypto = require("node:crypto"), { spawn } = require("node:child_process"), { once } = require("node:events");
const { performance } = require("node:perf_hooks");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

async function main() {
  const preview = process.argv.includes("--preview"), root = path.resolve(__dirname, "..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-catchment-api-"));
  const audit = path.join(directory, "outbound.json"), preload = path.join(directory, "no-network.cjs");
  await fs.writeFile(audit, "[]");
  await fs.writeFile(preload, `const fs=require('node:fs'),calls=[];global.fetch=async()=>{calls.push('FORBIDDEN_EXTERNAL_FETCH');fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(calls));throw Error('No outbound requests in catchment QA')};`);
  const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`, username = "catchment-local-qa", password = crypto.randomBytes(16).toString("hex");
  let child, output = "";
  async function start() {
    child = spawn(process.execPath, ["--max-old-space-size=256", "--require", preload, "scripts/glamping_app_server.cjs"], { cwd: root, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory,
        OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"), RENDER: "", RENDER_EXTERNAL_URL: "",
        SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local", KOSIS_API_KEY: "",
        GLAMPING_ADMIN_USER: username, GLAMPING_ADMIN_PASSWORD: password, GLAMPING_B2B_ENABLED: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0" } });
    child.stdout.on("data", bytes => { output = (output + bytes).slice(-12000); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-12000); });
    for (let n = 0; n < 240; n++) {
      if (child.exitCode !== null) throw Error("Local fixture app stopped: " + output.slice(-1500));
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await wait(50);
    }
    throw Error("Local fixture app did not start");
  }
  async function stop() { if (!child || child.exitCode !== null) return; const done = once(child, "exit"); child.kill(); await done; }
  async function request(route, cookie = "", payload, options = {}) {
    const response = await fetch(base + route, { method: payload === undefined ? "GET" : "POST", headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json", Origin: options.origin || base })
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login() {
    const response = await request("/api/login", "", { username, password }); assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const regionKey = "kr_gyeongnam_sancheong", query = "/api/regional-catchment?regionKey=" + regionKey;
  const center = { latitude: 35.4, longitude: 127.8, label: "[모의] 반경 계산 검수 중심점", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", confirmed: true };
  const observed = value => ({ status: "observed_public", value });
  const dataset = { id: "synthetic-grid-2024-1km", provider: "[모의] SGIS 개발 검수 자료", sourceUrl: center.sourceUrl,
    sourceYear: 2024, boundaryYear: 2025, gridSizeM: 1000, crs: "EPSG:4326", sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64),
    industryClassification: "[모의] KSIC11 전체산업", units: { population: "명", establishments: "개", workers: "명" },
    coverageBBox: [125, 33, 130, 38], completeFrame: true, cells: [
      { id: "synthetic-inner", latitude: 35.4, longitude: 127.8, population: observed(1000), establishments: observed(10), workers: observed(30) },
      { id: "synthetic-outer", latitude: 36, longitude: 127.8, population: observed(2000), establishments: observed(20), workers: observed(60) },
      { id: "synthetic-protected", latitude: 35.5, longitude: 127.8, population: { status: "protected_zero", value: 0 },
        establishments: { status: "suppressed", value: null }, workers: { status: "not_acquired", value: null } }
    ] };
  async function inventory() {
    const files = {}, baseDir = path.join(directory, "regional_catchment");
    async function visit(dir) {
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) { const file = path.join(dir, entry.name); assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) await visit(file); else files[path.relative(baseDir, file)] = sha(await fs.readFile(file)); }
    }
    await visit(baseDir); return files;
  }
  try {
    await start();
    assert.equal((await request(query)).status, 401);
    let cookie = await login();
    const emptyBefore = await inventory(), empty = await request(query, cookie);
    assert.equal(empty.status, 200); assert.equal(empty.data.status, "unqueried"); assert.equal(empty.data.snapshot, null);
    assert.deepEqual(await inventory(), emptyBefore, "Unconfigured GET cannot create a source or queue");
    assert.equal((await request(query + "&refresh=true", cookie)).status, 400);
    assert.equal((await request("/api/regional-catchment/datasets", cookie, dataset, { origin: "https://invalid.example" })).status, 403);
    assert.equal((await request("/api/regional-catchment/datasets", cookie, dataset)).status, 201);
    assert.equal((await request("/api/regional-catchment/configure", cookie, { regionKey, center: { ...center, latitude: null }, datasetId: dataset.id })).status, 400);
    assert.equal((await request("/api/regional-catchment/configure", cookie, { regionKey, center, datasetId: dataset.id })).status, 200);
    const started = await request("/api/regional-catchment/refresh", cookie, { regionKey }); assert.ok([200, 202].includes(started.status));
    let result;
    for (let n = 0; n < 160; n++) { result = (await request(query, cookie)).data; if (result.snapshot && !["queued", "running"].includes(result.job?.status)) break; await wait(25); }
    assert.ok(result.snapshot); assert.equal(result.snapshot.status, "partial");
    const [inner, outer, total] = result.snapshot.rings;
    assert.equal(inner.metrics.population.value, null); assert.equal(inner.metrics.population.publishedSum, 1000);
    assert.equal(inner.metrics.population.protectedZeroCells, 1); assert.equal(outer.metrics.population.value, 2000);
    assert.equal(total.metrics.population.value, null); assert.equal(total.metrics.population.publishedSum, 3000);
    assert.equal(total.coverage.selectedCells, inner.coverage.selectedCells + outer.coverage.selectedCells);
    const original = { resultId: result.snapshot.resultId, calculatedAt: result.snapshot.calculatedAt };
    const reused = await request("/api/regional-catchment/refresh", cookie, { regionKey }); assert.equal(reused.data.reused, true);
    assert.equal(reused.data.snapshot.resultId, original.resultId);
    const beforeReads = await inventory(), timings = [];
    for (let n = 0; n < 5; n++) { const began = performance.now(), read = await request(query, cookie); timings.push(+(performance.now() - began).toFixed(3));
      assert.equal(read.data.snapshot.resultId, original.resultId); assert.equal(read.data.snapshot.calculatedAt, original.calculatedAt); }
    assert.deepEqual(await inventory(), beforeReads, "Saved GET cannot rewrite inputs or results");
    await stop(); await start(); cookie = await login();
    const restarted = await request(query, cookie); assert.equal(restarted.data.snapshot.resultId, original.resultId);
    assert.equal(restarted.data.snapshot.calculatedAt, original.calculatedAt);
    assert.deepEqual(await inventory(), beforeReads, "Restarted read reuses the immutable result");
    assert.deepEqual(JSON.parse(await fs.readFile(audit, "utf8")), [], "No outbound provider calls");
    console.log(JSON.stringify({ status: "passed", environment: "isolated full app with clearly synthetic cells", protectedValuesPreserved: true,
      savedResultReusedAfterRestart: true, noGetWrites: true, externalCalls: 0, savedGetMilliseconds: timings, productionTiming: false }));
    if (preview) {
      console.log("LOCAL_CATCHMENT_PREVIEW=" + JSON.stringify({ url: base + "/admin", username, password, dataDir: directory, label: "[모의] 로컬 개발 검수" }));
      await new Promise(resolve => { const timer = setTimeout(finish, 30 * 60 * 1000); function finish() { clearTimeout(timer); process.stdin.removeListener("data", quit); process.stdin.pause(); resolve(); }
        function quit(value) { if (String(value).trim() === "q") finish(); } process.stdin.on("data", quit); process.stdin.resume(); });
    }
  } finally {
    await stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("regional-catchment-api-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
