"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

async function main() {
  const root = path.resolve(__dirname, "..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "collection-diagnostics-api-"));
  const dataDir = path.join(directory, "data"), outputsDir = path.join(dataDir, "outputs");
  const runId = "jeonnam_glamping_20260927_030000", runDir = path.join(outputsDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  const manifest = { keyword: "전남글램핑", collectionQuality: { status: "partial", reason: "product_targets_truncated" },
    counts: { naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverScheduleRequested: 80, naverScheduleSucceeded: 80, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    productCoverage: { targets: [{ businessId: "456", discovered: 62, eligible: 62, queried: 40, truncated: 22, excluded: 0, productListComplete: true,
      days: ["2026-09-27", "2026-09-28"].map(date => ({ date, eligible: 62, queried: 40, succeeded: 40, failed: 0, truncated: 22 })) }] },
    fileRoles: { overall: "rank.csv" }, files: ["rank.csv"], collectorRunToken: "TOKEN_MUST_NOT_LEAK", outputDir: "PRIVATE_DIRECTORY" };
  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(runDir, "rank.csv"), "place_id,업체명,네이버예약사업자ID,네이버예약재고수집상태\n123,모의 글램핑,456,성공\n");
  const outside = path.join(directory, "outside"); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "manifest.json"), JSON.stringify({ ...manifest, collectionQuality: { status: "complete", reason: "manifest_checks_passed" } }));
  await fs.symlink(outside, path.join(outputsDir, "outside_link"), process.platform === "win32" ? "junction" : "dir");
  const preload = path.join(directory, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { console.error('UNEXPECTED_EXTERNAL_FETCH'); throw new Error('External request forbidden'); };\n");
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: path.join(dataDir, "config"), RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0",
      MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local", GLAMPING_ADMIN_USER: "diagnostic-admin", GLAMPING_ADMIN_PASSWORD: "diagnostic-test-password",
      GLAMPING_B2B_ENABLED: "1", GLAMPING_B2B_USER: "diagnostic-member", GLAMPING_B2B_PASSWORD: "diagnostic-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  let output = "";
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, response, value };
  }
  async function login(username) {
    const response = await request("/api/login", "", "POST", { username, password: "diagnostic-test-password" });
    assert.equal(response.status, 200); return response.response.headers.get("set-cookie").split(";")[0];
  }
  async function snapshot(baseDir, prefix = "") {
    const files = {};
    for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name), file = path.join(baseDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) Object.assign(files, await snapshot(file, relative));
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        files[relative] = { sha: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"), mtime: stat.mtimeMs };
      }
    }
    return files;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${output}`);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "server ready");
    const endpoint = `/api/runs/${runId}/diagnostics`;
    assert.equal((await request(endpoint)).status, 401);
    const member = await login("diagnostic-member");
    assert.equal((await request(endpoint, member)).status, 403);
    const admin = await login("diagnostic-admin");
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = await snapshot(dataDir);
    const response = await request(endpoint, admin);
    assert.equal(response.status, 200);
    const diagnostics = response.value.collectionDiagnostics;
    assert.equal(diagnostics.status, "partial"); assert.equal(diagnostics.counts.naverScheduleFailed, 0);
    assert.deepEqual(diagnostics.issues.map(item => [item.companyName, item.expectedCount, item.queriedCount, item.affectedCount, item.countUnit]), [["모의 글램핑", 62, 40, 22, "products"]]);
    assert.deepEqual(diagnostics.issues[0].dates, ["2026-09-27", "2026-09-28"]);
    assert.doesNotMatch(JSON.stringify(response.value), /TOKEN_MUST_NOT_LEAK|PRIVATE_DIRECTORY|collectorRunToken/);
    for (const id of ["missing", "outside_link", "..%5Coutside", "%2Foutside", "..%2Foutside"]) {
      assert.equal((await request(`/api/runs/${id}/diagnostics`, admin)).status, 404, id);
    }
    assert.equal((await request(endpoint, admin, "POST", {})).status, 405);
    assert.deepEqual(await snapshot(dataDir), before, "diagnostic GET does not write outputs, histories, DB or configuration");
    assert.doesNotMatch(output, /UNEXPECTED_EXTERNAL_FETCH/, "diagnostic GET invokes no external provider");
    console.log("Collection diagnostics API: 401/403, exact stored causes, path/symlink isolation, no secrets, no writes and no external requests passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
