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
  const center = { address: "[모의] 경상남도 산청군 산청읍 검수로 1", latitude: 35.4, longitude: 127.8, label: "[모의] 반경 계산 검수 중심점", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", confirmed: true };
  const companyMasterFile = path.join(directory, "company_master", "companies.json");
  const companyMaster = { schemaVersion: 1, companies: {
    "synthetic-company-a": { companyId: "synthetic-company-a", primaryName: "[모의] 주소 검수 업체 A", addresses: ["경상남도 산청군 산청읍 모의검수로 10"], privateNote: "not-an-address-option" },
    "synthetic-company-b": { companyId: "synthetic-company-b", primaryName: "[모의] 주소 검수 업체 B", addresses: ["경상남도 산청군 산청읍 모의검수로 20"], privateNote: "not-an-address-option" }
  }, sourceIndex: {} };
  const companyMasterBytes = Buffer.from(JSON.stringify(companyMaster)), originalMasterSha = sha(companyMasterBytes);
  const addressQuery = "/api/regional-catchment/addresses?regionKey=" + regionKey;
  const companyQuery = companyId => query + "&companyId=" + encodeURIComponent(companyId);
  const observed = value => ({ status: "observed_public", value });
  const dataset = { id: "synthetic-grid-2024-1km", provider: "[모의] SGIS 개발 검수 자료", sourceUrl: center.sourceUrl,
    sourceYear: 2024, boundaryYear: 2025, gridSizeM: 1000, crs: "EPSG:4326", sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64),
    sourceEncoding: "cp949", sourceTransform: "none", derivedCsvSha256: "c".repeat(64),
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
  async function companySaved(companyId, cookie) {
    let response;
    for (let n = 0; n < 160; n++) {
      response = await request(companyQuery(companyId), cookie); assert.equal(response.status, 200);
      if (response.data.snapshot && !["queued", "running"].includes(response.data.job?.status)) return response.data;
      await wait(25);
    }
    assert.fail(`Synthetic company ${companyId} did not publish a saved result: ${response?.data?.job?.errorCode || response?.data?.status}`);
  }
  function checkAddressOptions(body, expectedCompanies) {
    assert.equal(body.addresses.length, 2);
    for (const option of body.addresses) {
      assert.deepEqual(Object.keys(option).sort(), ["address", "companyId", "label", "status"]);
      const expected = expectedCompanies[option.companyId]; assert.ok(expected);
      assert.equal(option.label, expected.primaryName); assert.equal(option.address, expected.addresses[0]); assert.equal(option.status, "ready");
    }
    assert.equal(new Set(body.addresses.map(option => option.companyId)).size, 2);
  }
  try {
    await fs.mkdir(path.dirname(companyMasterFile), { recursive: true }); await fs.writeFile(companyMasterFile, companyMasterBytes);
    await start();
    assert.equal((await request(query)).status, 401);
    assert.equal((await request(addressQuery)).status, 401);
    const marketQuery = "/api/regional-market?regionKey=" + regionKey;
    assert.equal((await request(marketQuery)).status, 401);
    let cookie = await login();
    const marketBefore = await inventory(), market = await request(marketQuery, cookie);
    assert.equal(market.status, 200); assert.equal(market.data.mode, "administrative_region");
    assert.equal(market.data.status, "missing"); assert.equal(market.data.metrics.length, 6);
    assert.ok(market.data.metrics.every(metric => metric.value === null && metric.status === "missing"));
    assert.equal(market.data.networkAttempted, false); assert.equal(market.data.readOnly, true);
    assert.deepEqual(await inventory(), marketBefore, "Region-only GET cannot create a source, queue, address configuration or result");
    assert.equal((await request(marketQuery + "&companyId=synthetic-company-a", cookie)).status, 400);
    assert.equal((await request("/api/regional-market", cookie, { regionKey })).status, 405);
    const options = await request(addressQuery, cookie); assert.equal(options.status, 200); checkAddressOptions(options.data, companyMaster.companies);
    assert.equal(sha(await fs.readFile(companyMasterFile)), originalMasterSha, "Address lookup cannot rewrite the synthetic master");
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
    assert.equal(result.snapshot.dataset.sourceEncoding, "cp949");
    assert.equal(result.snapshot.dataset.sourceSha256, dataset.sourceSha256);
    assert.equal(result.snapshot.dataset.derivedCsvSha256, dataset.derivedCsvSha256);
    const [inner, outer, total] = result.snapshot.rings;
    assert.equal(inner.metrics.population.value, null); assert.equal(inner.metrics.population.publishedSum, 1000);
    assert.equal(inner.metrics.population.protectedZeroCells, 1); assert.equal(outer.metrics.population.value, 2000);
    assert.equal(total.metrics.population.value, null); assert.equal(total.metrics.population.publishedSum, 3000);
    assert.equal(total.coverage.selectedCells, inner.coverage.selectedCells + outer.coverage.selectedCells);
    const original = { resultId: result.snapshot.resultId, calculatedAt: result.snapshot.calculatedAt };
    const reused = await request("/api/regional-catchment/refresh", cookie, { regionKey }); assert.equal(reused.data.reused, true);
    assert.equal(reused.data.snapshot.resultId, original.resultId);
    const companyIds = Object.keys(companyMaster.companies), companyResults = new Map();
    const firstCompany = companyMaster.companies[companyIds[0]], secondCompany = companyMaster.companies[companyIds[1]];
    const wrongAddress = await request("/api/regional-catchment/configure", cookie, { regionKey, companyId: firstCompany.companyId,
      center: { ...center, address: secondCompany.addresses[0] }, datasetId: dataset.id });
    assert.equal(wrongAddress.status, 409); assert.equal(wrongAddress.data.code, "CATCHMENT_ADDRESS_MISMATCH");
    assert.equal((await request("/api/regional-catchment/configure", cookie, { regionKey, companyId: firstCompany.companyId,
      center: { ...center, address: firstCompany.addresses[0], companyId: secondCompany.companyId }, datasetId: dataset.id })).status, 400);
    for (const [index, companyId] of companyIds.entries()) {
      const company = companyMaster.companies[companyId];
      const configured = await request("/api/regional-catchment/configure", cookie, { regionKey, companyId,
        center: { ...center, address: company.addresses[0], label: company.primaryName, latitude: 35.4 + index * 0.01 }, datasetId: dataset.id });
      assert.equal(configured.status, 200); assert.equal(configured.data.configuration.companyId, companyId);
      assert.equal(configured.data.configuration.center.companyId, companyId, "Server binds the company without a caller-supplied center.companyId");
      assert.equal(configured.data.configuration.center.address, company.addresses[0]);
      const calculation = await request("/api/regional-catchment/refresh", cookie, { regionKey, companyId }); assert.ok([200, 202].includes(calculation.status));
      const saved = await companySaved(companyId, cookie); assert.equal(saved.scope.companyId, companyId); assert.equal(saved.snapshot.scope.companyId, companyId);
      assert.equal(saved.snapshot.scope.center.companyId, companyId); assert.equal(saved.snapshot.scope.center.address, company.addresses[0]);
      companyResults.set(companyId, { resultId: saved.snapshot.resultId, calculatedAt: saved.snapshot.calculatedAt, sourceFingerprint: saved.snapshot.sourceFingerprint });
    }
    assert.notEqual(companyResults.get(companyIds[0]).resultId, companyResults.get(companyIds[1]).resultId);
    assert.notEqual(companyResults.get(companyIds[0]).sourceFingerprint, companyResults.get(companyIds[1]).sourceFingerprint);
    assert.ok(companyIds.every(companyId => companyResults.get(companyId).resultId !== original.resultId));
    assert.equal((await request(query, cookie)).data.snapshot.resultId, original.resultId, "Company calculations cannot replace the regional result");
    assert.equal(sha(await fs.readFile(companyMasterFile)), originalMasterSha, "Company configure/refresh cannot rewrite the synthetic master");
    const beforeReads = await inventory(), timings = [];
    for (let n = 0; n < 5; n++) { const began = performance.now(), read = await request(query, cookie); timings.push(+(performance.now() - began).toFixed(3));
      assert.equal(read.data.snapshot.resultId, original.resultId); assert.equal(read.data.snapshot.calculatedAt, original.calculatedAt); }
    assert.deepEqual(await inventory(), beforeReads, "Saved GET cannot rewrite inputs or results");
    await stop(); await start(); cookie = await login();
    const restarted = await request(query, cookie); assert.equal(restarted.data.snapshot.resultId, original.resultId);
    assert.equal(restarted.data.snapshot.calculatedAt, original.calculatedAt);
    assert.equal(restarted.data.snapshot.dataset.sourceEncoding, "cp949");
    assert.equal(restarted.data.snapshot.dataset.derivedCsvSha256, dataset.derivedCsvSha256);
    assert.deepEqual(await inventory(), beforeReads, "Restarted read reuses the immutable result");
    for (const companyId of companyIds) {
      const read = await request(companyQuery(companyId), cookie); assert.equal(read.status, 200);
      assert.equal(read.data.snapshot.resultId, companyResults.get(companyId).resultId); assert.equal(read.data.snapshot.calculatedAt, companyResults.get(companyId).calculatedAt);
    }
    assert.equal(sha(await fs.readFile(companyMasterFile)), originalMasterSha, "App restart and saved reads cannot rewrite the synthetic master");
    const beforeAddressChange = await inventory(), changedMaster = structuredClone(companyMaster);
    changedMaster.companies[firstCompany.companyId].addresses = ["경상남도 산청군 산청읍 모의검수로 30"];
    const changedMasterBytes = Buffer.from(JSON.stringify(changedMaster));
    await fs.writeFile(companyMasterFile, changedMasterBytes);
    const changedOptions = await request(addressQuery, cookie); assert.equal(changedOptions.status, 200); checkAddressOptions(changedOptions.data, changedMaster.companies);
    const moved = await request(companyQuery(firstCompany.companyId), cookie); assert.equal(moved.status, 200); assert.equal(moved.data.snapshot, null);
    assert.equal(moved.data.status, "unqueried"); assert.equal(moved.data.storage.errorCode, "CATCHMENT_ADDRESS_MISMATCH"); assert.notEqual(moved.data.reused, true);
    const rejectedReuse = await request("/api/regional-catchment/refresh", cookie, { regionKey, companyId: firstCompany.companyId });
    assert.equal(rejectedReuse.status, 409); assert.equal(rejectedReuse.data.code, "CATCHMENT_ADDRESS_MISMATCH");
    const unchanged = await request(companyQuery(secondCompany.companyId), cookie); assert.equal(unchanged.status, 200);
    assert.equal(unchanged.data.snapshot.resultId, companyResults.get(secondCompany.companyId).resultId);
    assert.equal(unchanged.data.snapshot.calculatedAt, companyResults.get(secondCompany.companyId).calculatedAt);
    const unchangedReuse = await request("/api/regional-catchment/refresh", cookie, { regionKey, companyId: secondCompany.companyId });
    assert.equal(unchangedReuse.status, 200); assert.equal(unchangedReuse.data.reused, true); assert.equal(unchangedReuse.data.snapshot.resultId, companyResults.get(secondCompany.companyId).resultId);
    assert.equal((await request(query, cookie)).data.snapshot.resultId, original.resultId);
    assert.deepEqual(await inventory(), beforeAddressChange, "An address-source change and saved reads cannot mutate catchment evidence");
    assert.equal(sha(await fs.readFile(companyMasterFile)), sha(changedMasterBytes), "Only this test's intentional company A address edit may change the synthetic master");
    assert.deepEqual(JSON.parse(await fs.readFile(audit, "utf8")), [], "No outbound provider calls");
    console.log(JSON.stringify({ status: "passed", environment: "isolated full app with clearly synthetic cells", protectedValuesPreserved: true,
      savedResultReusedAfterRestart: true, companyAddressScopesSeparated: true, changedAddressBlocksReuse: true, syntheticMasterPreserved: true,
      noGetWrites: true, externalCalls: 0, savedGetMilliseconds: timings, productionTiming: false }));
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
