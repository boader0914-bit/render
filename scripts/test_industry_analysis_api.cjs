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
  const childOptions = {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "industry-admin", GLAMPING_ADMIN_PASSWORD: "industry-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "industry-member", GLAMPING_B2B_PASSWORD: "industry-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  };
  let child;
  function startServer() {
    child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], childOptions);
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  }
  async function stopServer() { child.kill(); if (child.exitCode === null) await once(child, "exit"); }
  async function waitServer() {
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Server unavailable: ${output}`);
  }
  startServer();
  async function request(route, cookie = "", method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "industry-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  async function readyAnalysis(route, admin, accept = () => true) {
    for (let index = 0; index < 240; index++) {
      const result = await request(route, admin);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.ok(result.data.storage, "persistent lifecycle is explicit");
      if (result.data.storage.status === "failed") throw new Error(JSON.stringify(result.data));
      if (!result.data.storage.hasSnapshot) assert.equal(result.data.summary, undefined, "pending is not zero observations");
      if (result.data.storage.status === "ready" && accept(result.data)) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Analysis did not settle: ${output}`);
  }
  try {
    await waitServer();
    const route = "/api/industry-analysis?industry=glamping&month=2026-08&region=all";
    assert.equal((await request(route)).status, 401);
    const member = await login("industry-member");
    assert.equal((await request(route, member)).status, 403);
    let admin = await login("industry-admin");
    const options = await request("/api/industry-analysis/options", admin);
    assert.equal(options.status, 200, JSON.stringify(options.data));
    assert.ok(options.data.regions.some(row => row.id === "kr_gyeongnam_sacheon" && row.indicatorCandidate));
    assert.deepEqual(options.data.features, { scaleGroups: false, performanceTiers: false });
    const analysis = await readyAnalysis(route, admin);
    assert.equal(analysis.status, 200, JSON.stringify(analysis.data));
    assert.equal(analysis.data.summary.companyCount, 2);
    assert.equal(analysis.data.summary.coveredCompanyDays, 62);
    assert.equal(analysis.data.summary.coverageRate, 1);
    assert.ok(analysis.data.summary.reservationRate > 0 && analysis.data.summary.reservationRate < 1);
    assert.deepEqual(analysis.data.companies.map(row => row.capacity).sort((a,b) => a-b), [8, 10]);
    assert.equal(analysis.data.context.networkAttempted, false);
    assert.equal(analysis.data.storage.stale, false);
    assert.equal(analysis.data.storage.sourceRevision, analysis.data.storage.resultRevision);
    assert.equal(analysis.data.request.cutoffDate, "2026-08-31");
    assert.equal(analysis.data.storage.monthClosed, true);
    assert.equal(analysis.data.storage.reusePolicy, "closed_month");
    assert.ok(analysis.data.storage.calculatedAt);
    const savedRead = await request(route, admin);
    assert.equal(savedRead.data.storage.calculatedAt, analysis.data.storage.calculatedAt, "GET reuses saved result");
    assert.deepEqual(savedRead.data.summary, analysis.data.summary);
    const region = await readyAnalysis(route.replace("region=all", "region=kr_gyeonggi_pocheon"), admin);
    assert.equal(region.status, 200, JSON.stringify(region.data));
    assert.equal(region.data.summary.companyCount, 2);
    assert.equal(region.data.context.networkAttempted, false);
    const sacheon = await readyAnalysis(route.replace("region=all", "region=kr_gyeongnam_sacheon"), admin);
    assert.equal(sacheon.status, 200, JSON.stringify(sacheon.data));
    assert.equal(sacheon.data.summary.companyCount, 0);
    assert.equal(sacheon.data.summary.reservationRate, null);
    assert.equal(sacheon.data.context.networkAttempted, false);
    for (const suffix of ["&month=2026-09", "&unknown=1"]) assert.equal((await request(route + suffix, admin)).status, 400);
    assert.equal((await request(route.replace("2026-08", "2026-13"), admin)).status, 400);
    assert.equal((await request(route, admin, "POST", {})).status, 405);
    const rebuildRoute = "/api/industry-analysis/rebuild", conditions = { industry: "glamping", month: "2026-08", region: "all", cutoffDate: analysis.data.request.cutoffDate };
    assert.equal((await request(rebuildRoute, "", "POST", conditions)).status, 401);
    assert.equal((await request(rebuildRoute, member, "POST", conditions)).status, 403);
    assert.equal((await request(rebuildRoute, admin)).status, 405);
    assert.equal((await request(rebuildRoute + "?month=2026-08", admin, "POST", conditions)).status, 400);
    assert.equal((await request(rebuildRoute, admin, "POST", { ...conditions, crawl: true })).status, 400);
    assert.equal((await fetch(base + rebuildRoute, { method: "POST", headers: { Cookie: admin }, body: "{}" })).status, 415);
    assert.equal((await fetch(base + rebuildRoute, { method: "POST", headers: { Cookie: admin, "Content-Type": "application/json", Origin: "https://unrelated.invalid" }, body: JSON.stringify(conditions) })).status, 403);
    assert.deepEqual(await fs.readFile(historyFile), originalHistory, "raw observations unchanged");
    assert.deepEqual(await fs.readFile(masterFile), originalMaster, "company records unchanged");
    const crawl = await request("/api/crawl-status", admin);
    assert.equal(crawl.data.active, false);
    // Reopening the same saved condition survives a process restart.
    await stopServer(); startServer(); await waitServer(); admin = await login("industry-admin");
    const reopened = await request(route, admin);
    assert.equal(reopened.data.storage.status, "ready", JSON.stringify(reopened.data));
    assert.equal(reopened.data.storage.calculatedAt, analysis.data.storage.calculatedAt);
    assert.deepEqual(reopened.data.summary, analysis.data.summary);
    // A collection in another month is discovered after restart, without
    // rebuilding or relabeling the already saved August result.
    await stopServer();
    const nextRunId = "pocheon_glamping_20260901_090000", nextRunDir = path.join(dataDir, "outputs", nextRunId);
    const nextTime = "2026-09-01T00:00:00Z";
    await fs.mkdir(nextRunDir, { recursive: true });
    await fs.writeFile(path.join(nextRunDir, "manifest.json"), JSON.stringify({ id: nextRunId, keyword: "포천글램핑",
      searchMode: "keyword", checkIn: "2026-09-01", checkOut: "2026-09-02", bookingRangeDays: 14,
      completedAt: nextTime, collectionQuality: { status: "complete" }, counts: { overall: 1 }, files: ["manifest.json"] }));
    const temporaryMaster = JSON.parse(originalMaster.toString());
    const company = temporaryMaster.companies.cmp_place_monthly_a;
    company.lastSeenAt = nextTime;
    company.keywords["포천글램핑"].runs.push({ runId: nextRunId, collectedAt: nextTime, rank: 1 });
    await fs.writeFile(masterFile, JSON.stringify(temporaryMaster));
    const extraObservation = { ...JSON.parse(originalHistory.toString().split("\n")[0]),
      observationId: "other-month-saved", runId: nextRunId, collectedAt: nextTime, stayDate: "2026-09-01", rank: 1 };
    await fs.appendFile(historyFile, JSON.stringify(extraObservation) + "\n");
    startServer(); await waitServer(); admin = await login("industry-admin");
    const afterOtherMonth = await request(route, admin);
    assert.equal(afterOtherMonth.data.storage.status, "ready", JSON.stringify(afterOtherMonth.data));
    assert.equal(afterOtherMonth.data.storage.calculatedAt, analysis.data.storage.calculatedAt);
    assert.equal(afterOtherMonth.data.storage.resultRevision, analysis.data.storage.resultRevision);
    assert.deepEqual(afterOtherMonth.data.summary, analysis.data.summary);
    await stopServer();
    await fs.writeFile(masterFile, originalMaster); await fs.writeFile(historyFile, originalHistory);
    startServer(); await waitServer(); admin = await login("industry-admin");
    // Reviewed capacity edits automatically dirty every saved historical scope.
    const correction = await request("/api/company-master/manual-correction", admin, "POST", { companyId: "cmp_place_monthly_a", lodgingBasisTotal: 11, expectedRevision: 0 });
    assert.equal(correction.status, 200, JSON.stringify(correction.data));
    const updated = await readyAnalysis(route, admin, data => data.companies.some(company => company.companyId === "cmp_place_monthly_a" && company.capacity === 11));
    assert.notEqual(updated.data.storage.resultRevision, analysis.data.storage.resultRevision);
    assert.notEqual(updated.data.storage.calculatedAt, analysis.data.storage.calculatedAt);
    const updatedRegion = await readyAnalysis(route.replace("region=all", "region=kr_gyeonggi_pocheon"), admin,
      data => data.companies.some(company => company.companyId === "cmp_place_monthly_a" && company.capacity === 11));
    assert.equal(updatedRegion.data.storage.resultRevision, updated.data.storage.resultRevision);
    const retry = await request(rebuildRoute, admin, "POST", conditions);
    assert.equal(retry.status, 202);
    assert.equal(retry.data.storage.hasSnapshot, true, "manual rebuild retains last normal result");
    const rebuilt = await readyAnalysis(route, admin);
    assert.deepEqual(rebuilt.data.summary, updated.data.summary, "same input has unchanged arithmetic");
    assert.deepEqual(await fs.readFile(historyFile), originalHistory, "review refresh does not rewrite observations");
    assert.equal((await request("/api/crawl-status", admin)).data.active, false, "saved rebuild never starts a crawler");
    console.log("Industry analysis API passed: closed-month cutoff and reuse across other-month collections/restart, automatic historical review refresh, explicit rebuild guards, admin-only scopes, no external fetch, unchanged raw history");
  } finally {
    await stopServer();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
