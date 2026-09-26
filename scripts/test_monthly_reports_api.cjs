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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(dataDir, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { throw new Error('Provider requests forbidden during report validation'); };\n");
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "monthly-admin", GLAMPING_ADMIN_PASSWORD: "monthly-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "monthly-member", GLAMPING_B2B_PASSWORD: "monthly-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("content-type")?.includes("application/pdf")) return { status: response.status, response, data: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "monthly-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error("Server did not start: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const endpoint = "/api/monthly-reports";
    assert.equal((await request(endpoint)).status, 401);
    const member = await login("monthly-member");
    assert.equal((await request(endpoint + "/options", member)).status, 403);
    assert.equal((await request(endpoint, member, "POST", {})).status, 403);
    const admin = await login("monthly-admin");
    const opts = await request(endpoint + "/options", admin);
    assert.equal(opts.status, 200); assert.ok(opts.data.months.includes("2026-08"));
    const condition = { type: "company", targetId: fixture.companyId, month: "2026-08", cutoffDate: "2026-08-31" };
    assert.equal((await request(endpoint + "/preview", admin, "POST", condition, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await request(endpoint + "/preview", admin, "POST", condition, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await request(endpoint + "/preview", admin, "POST", { ...condition, month: "2026-13" })).status, 400);
    const preview = await request(endpoint + "/preview", admin, "POST", condition);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.summary.lodging.coveredCompanyDays, 31, JSON.stringify(preview.data.quality));
    assert.equal(preview.data.summary.lodging.supply, 310);
    assert.ok(preview.data.previewToken);
    assert.equal(preview.data.comparison.previousMonth, "2026-07");
    assert.equal(preview.data.comparison.common.companyCount, 1);
    assert.equal(preview.data.comparison.common.matched.deltas.sold, 31);
    const keywordPreview = await request(endpoint + "/preview", admin, "POST", { ...condition, type: "keyword", targetId: "포천글램핑" });
    assert.equal(keywordPreview.status, 200);
    assert.equal(keywordPreview.data.comparison.all.current.companyCount, 2);
    assert.equal(keywordPreview.data.comparison.all.previous.companyCount, 1);
    assert.deepEqual(keywordPreview.data.comparison.newlyObservedCompanyIds, ["cmp_place_monthly_b"]);
    assert.equal(keywordPreview.data.comparison.common.matched.deltas.sold, 31, "new company's sales never inflate common-company movement");
    assert.equal(keywordPreview.data.insights.overview.totalRooms, 18, "physical room basis is not the monthly room-night total");
    assert.equal(keywordPreview.data.insights.overview.collectionDateCount, 2);
    assert.equal(keywordPreview.data.insights.pricing.lodging.companyDistribution.companyCount, 2);
    assert.equal(keywordPreview.data.insights.pickup.lodging.public.increase, 34);
    assert.equal(keywordPreview.data.insights.rankVisibility.rows[0].observedDays, 2, "31 stay dates do not become 31 search observations");
    assert.equal(keywordPreview.data.insights.calendarGroups.status, "unavailable", "missing holiday cache is not ordinary-weekday evidence");
    const create = await request(endpoint, admin, "POST", { ...condition, previewToken: preview.data.previewToken, title: "[모의] 8월 월간 리포트", notes: "검수용 가상 자료입니다." });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    const reportUrl = endpoint + "/" + create.data.id;
    assert.equal((await request(reportUrl + "/pdf", admin)).status, 409);
    assert.equal((await request(reportUrl + "/publish", admin, "POST", { revision: 1, acknowledgeQuality: true })).status, 409);
    const review = await request(reportUrl, admin, "PATCH", { revision: 1, status: "review" });
    assert.equal(review.status, 200);
    assert.equal((await request(reportUrl, admin, "PATCH", { revision: 1, notes: "stale" })).status, 409);
    const published = await request(reportUrl + "/publish", admin, "POST", { revision: review.data.revision, acknowledgeQuality: true });
    assert.equal(published.status, 200); assert.equal(published.data.status, "published");
    assert.equal((await request(reportUrl, admin, "PATCH", { revision: published.data.revision, notes: "overwrite" })).status, 409);
    const pdf = await request(reportUrl + "/pdf", admin);
    assert.equal(pdf.status, 200, String(pdf.data)); assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.response.headers.get("content-disposition").includes("attachment"));
    assert.deepEqual((await request(reportUrl + "/pdf", admin)).data, pdf.data, "issued PDF bytes stay fixed");
    const revision = await request(reportUrl + "/revise", admin, "POST", { revision: published.data.revision });
    assert.equal(revision.status, 201); assert.equal(revision.data.version, 2); assert.notEqual(revision.data.id, create.data.id);
    const rebuilt = await request(endpoint + "/" + revision.data.id + "/rebuild", admin, "POST", { revision: revision.data.revision });
    assert.equal(rebuilt.status, 200); assert.equal(rebuilt.data.status, "draft");
    assert.deepEqual((await request(reportUrl, admin)).data.snapshot, published.data.snapshot);
    const list = await request(endpoint, admin);
    assert.equal(list.data.reports.length, 2);
    assert.equal((await request(endpoint + "/not-an-id", admin)).status, 400);
    assert.equal((await request(reportUrl + "/pdf", member)).status, 403);
    console.log("Monthly reports API: authorization, source adapter, preview/draft/review/publication, conflicts, immutable PDF and revised draft passed");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
