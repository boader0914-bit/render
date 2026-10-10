"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

async function main() {
  const root = path.resolve(__dirname, "..");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const originalHistory = await fs.readFile(path.join(dataDir, "history", "observations.jsonl"));
  const originalMaster = await fs.readFile(path.join(dataDir, "company_master", "companies.json"));
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, preload = path.join(dataDir, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { throw new Error('External requests forbidden'); };\n");
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "integrated-admin", GLAMPING_ADMIN_PASSWORD: "integrated-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "integrated-member", GLAMPING_B2B_PASSWORD: "integrated-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "integrated-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  try {
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = `/api/company-master/integrated?companyId=${fixture.companyId}&month=2026-08`;
    assert.equal((await request(url)).status, 401);
    assert.equal((await request(url, await login("integrated-member"))).status, 403);
    const admin = await login("integrated-admin");
    let integrated;
    for (let i = 0; i < 120; i++) {
      integrated = await request(url, admin);
      assert.equal(integrated.status, 200, JSON.stringify(integrated.data));
      if (integrated.data.status === "ready") break;
      if (integrated.data.status === "failed") throw new Error(JSON.stringify(integrated.data));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(integrated.data.status, "ready", output);
    assert.deepEqual(integrated.data.months.map(row => row.month).sort(), ["2026-07", "2026-08"]);
    assert.equal(integrated.data.roomBasis.capacity, 10);
    assert.equal(integrated.data.roomBasis.source, "db_review");
    assert.equal(integrated.data.keywords.length, 2);
    const preview = await request("/api/monthly-reports/preview", admin, "POST", { type: "company", targetId: fixture.companyId, month: "2026-08", cutoffDate: "2026-08-31" });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.deepEqual(integrated.data.snapshot.summary, preview.data.summary, "all customer/monthly amounts share one engine");
    assert.deepEqual(integrated.data.snapshot.sources.observations, preview.data.sources.observations);
    assert.equal((await request(url.replace("2026-08", "2026-13"), admin)).status, 400);
    assert.equal((await request(url.replace(fixture.companyId, "unknown-company"), admin)).status, 404);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "history", "observations.jsonl")), originalHistory);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "company_master", "companies.json")), originalMaster);
    // Existing reviewed-value edit must enqueue derived data automatically.
    const correction = await request("/api/company-master/manual-correction", admin, "POST", { companyId: fixture.companyId, lodgingBasisTotal: 11, expectedRevision: 0 });
    assert.equal(correction.status, 200, JSON.stringify(correction.data));
    let updated;
    for (let i = 0; i < 120; i++) {
      updated = await request(url, admin);
      if (updated.data.status === "ready" && updated.data.roomBasis.capacity === 11) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(updated.data.roomBasis.capacity, 11);
    assert.equal(updated.data.status, "ready");
    assert.notEqual(updated.data.calculatedAt, integrated.data.calculatedAt);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "history", "observations.jsonl")), originalHistory, "recalculation leaves raw history untouched");
    console.log("Company integration API: automatic historical build, auth, exact monthly parity, correction refresh and raw preservation passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
