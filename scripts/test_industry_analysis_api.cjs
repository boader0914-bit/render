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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "industry-analysis-api-"));
  await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  const masterFile = path.join(dataDir, "company_master", "companies.json");
  const originalHistory = await fs.readFile(historyFile), originalMaster = await fs.readFile(masterFile);
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, preload = path.join(dataDir, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { throw new Error('External requests forbidden'); };\n");
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "industry-admin", GLAMPING_ADMIN_PASSWORD: "industry-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "industry-member", GLAMPING_B2B_PASSWORD: "industry-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "industry-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const route = "/api/industry-analysis?industry=glamping&month=2026-08&region=all";
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, await login("industry-member"))).status, 403);
    const admin = await login("industry-admin");
    const options = await request("/api/industry-analysis/options", admin);
    assert.equal(options.status, 200, JSON.stringify(options.data));
    assert.ok(options.data.regions.some(row => row.id === "kr_gyeongnam_sacheon" && row.indicatorCandidate));
    assert.deepEqual(options.data.features, { scaleGroups: false, performanceTiers: false });
    const analysis = await request(route, admin);
    assert.equal(analysis.status, 200, JSON.stringify(analysis.data));
    assert.equal(analysis.data.summary.companyCount, 2);
    assert.equal(analysis.data.summary.coveredCompanyDays, 62);
    assert.equal(analysis.data.summary.coverageRate, 1);
    assert.ok(analysis.data.summary.reservationRate > 0 && analysis.data.summary.reservationRate < 1);
    assert.deepEqual(analysis.data.companies.map(row => row.capacity).sort((a,b) => a-b), [8, 10]);
    assert.equal(analysis.data.context.networkAttempted, false);
    const region = await request(route.replace("region=all", "region=kr_gyeonggi_pocheon"), admin);
    assert.equal(region.status, 200, JSON.stringify(region.data));
    assert.equal(region.data.summary.companyCount, 2);
    assert.equal(region.data.context.networkAttempted, false);
    const sacheon = await request(route.replace("region=all", "region=kr_gyeongnam_sacheon"), admin);
    assert.equal(sacheon.status, 200, JSON.stringify(sacheon.data));
    assert.equal(sacheon.data.summary.companyCount, 0);
    assert.equal(sacheon.data.summary.reservationRate, null);
    assert.equal(sacheon.data.context.networkAttempted, false);
    for (const suffix of ["&month=2026-09", "&unknown=1"]) assert.equal((await request(route + suffix, admin)).status, 400);
    assert.equal((await request(route.replace("2026-08", "2026-13"), admin)).status, 400);
    assert.equal((await request(route, admin, "POST", {})).status, 405);
    assert.deepEqual(await fs.readFile(historyFile), originalHistory, "raw observations unchanged");
    assert.deepEqual(await fs.readFile(masterFile), originalMaster, "company records unchanged");
    const crawl = await request("/api/crawl-status", admin);
    assert.equal(crawl.data.active, false);
    console.log("Industry analysis API passed: admin-only, saved cohort, latest valid aggregation, Sacheon missing state, no external fetch, unchanged raw data");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
