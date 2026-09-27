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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-preparation-api-"));
  await seedMonthlyReportFixture(dataDir);
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(dataDir, "mock-providers.cjs");
  const auditFile = path.join(dataDir, "provider-test-calls.json");
  await fs.writeFile(preload, `
    const fs = require('node:fs');
    const calls = []; const auditFile = ${JSON.stringify(auditFile)};
    const record = key => { calls.push(key); fs.writeFileSync(auditFile, JSON.stringify(calls)); };
    fs.writeFileSync(auditFile, '[]');
    global.fetch = async () => { record('FORBIDDEN_EXTERNAL_FETCH'); throw new Error('External requests forbidden'); };
    const tourism = require(${JSON.stringify(path.join(root, "scripts/tourism_collector.cjs"))});
    const original = tourism.createCollector;
    const ready = new Set();
    tourism.createCollector = options => {
      const collector = original(options);
      for (const method of ['collectVisitorHistory','collectDemandStrengthHistory','collectResourceDemandHistory','collectDiversityHistory']) {
        collector[method] = async input => {
          const regionKey = input.regionKey || input.regionKeys?.[0];
          const yearMonth = input.endYearMonth;
          const key = method + ':' + regionKey + ':' + yearMonth;
          const collected = Boolean(input.collectMissing);
          if (collected) { record(key); await new Promise(resolve => setTimeout(resolve, 60)); ready.add(key); }
          const complete = ready.has(key);
          const point = { yearMonth, status: complete ? 'complete' : 'missing', collectedAt: complete ? new Date().toISOString() : '',
            ...(complete ? { averageDailyVisitors: 0, visitorDays: 0, stayOverall: 45, spendOverall: 35,
              values: { service: 12, culture: 8, visitor: 0, spend: 3, international: 2 } } : {}) };
          return { ok: complete, status: complete ? 'ok' : 'missing', period: { endYearMonth: yearMonth },
            ...(method === 'collectVisitorHistory' ? { regions: [{ regionKey, series: [point] }] } : { region: { regionKey }, series: [point] }),
            collection: { networkAttemptedMonths: collected ? 1 : 0, operationCallsAttempted: collected ? 1 : 0, networkFailedMonths: 0 } };
        };
      }
      return collector;
    };
    const trends = require(${JSON.stringify(path.join(root, "scripts/lib/regional_search_trends.cjs"))});
    trends.createRegionalSearchTrendService = () => {
      const cache = new Map();
      return { status: async () => ({ configured: true, lastCheckedAt: cache.size ? new Date().toISOString() : '', lastSuccessAt: cache.size ? new Date().toISOString() : '', errorCode: '' }),
        get: async ({regionKey,month}) => ({ ...(cache.get(regionKey + ':' + month) || {regionKey,keyword:'포천글램핑',status:'missing',series:[]}), networkAttempted:false }),
        refresh: async ({regionKey,month}) => {
          const id = regionKey + ':' + month;
          if (cache.has(id)) return {...cache.get(id),networkAttempted:false,cacheReused:true};
          record('searchTrend:' + id);
          const value={regionKey,keyword:'포천글램핑',status:'ready',startDate:'2025-09-01',endDate:'2026-08-31',timeUnit:'month',configured:true,
            retrievedAt:new Date().toISOString(),networkAttempted:true,series:[{period:month+'-01',ratio:0,value:0,status:'observed'}]};
          cache.set(id,value); return value;
        }};
    };
    const kosis = require(${JSON.stringify(path.join(root, "scripts/lib/kosis.cjs"))});
    kosis.createKosisService = () => {
      const cache = new Map();
      const getRegion = async regionKey => cache.has(regionKey) ? { ...cache.get(regionKey), networkAttempted: false }
        : { region: { regionKey }, status: 'not_collected', datasets: [], networkAttempted: false };
      return { getRegion, status: async () => ({ status: 'test' }), refreshRegion: async regionKey => {
        record('kosis:' + regionKey);
        const result = { region: { regionKey }, status: 'ready', networkAttempted: true, datasets: kosis.DEFINITIONS.map(definition => ({
          key: definition.key, label: definition.label, period: definition.periodType === 'M' ? '202608' : '2025', periodType: definition.periodType,
          status: 'ready', retrievedAt: new Date().toISOString(), rows: definition.metrics.flatMap(metric => (definition.breakdowns || [null])
            .map(breakdown => ({ key: breakdown?.key || metric.key, unit: metric.unit, label: '검수 예시', value: 0, status: 'observed' })))
        })) };
        cache.set(regionKey, result); return result;
      } };
    };
  `);
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "regional-test-admin", GLAMPING_ADMIN_PASSWORD: "regional-local-fixture", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "regional-test-member", GLAMPING_B2B_PASSWORD: "regional-local-fixture",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  async function request(route, cookie = "", method = "GET", body, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "regional-local-fixture" }); assert.equal(result.status, 200); return result.headers.get("set-cookie").split(";")[0]; };
  try {
    let healthy = false;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error("Server failed to start: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(healthy, output);
    const endpoint = "/api/regional-report-preparation";
    const condition = { regionKey: "kr_gyeonggi_pocheon", month: "2026-08", cutoffDate: "2026-08-31" };
    const query = endpoint + "?" + new URLSearchParams({ regionKey: condition.regionKey, month: condition.month });
    assert.equal((await request(query)).status, 401);
    const member = await login("regional-test-member");
    assert.equal((await request(endpoint, member, "POST", condition)).status, 403);
    const admin = await login("regional-test-admin");
    assert.equal((await request(query, admin)).data.job, null);
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile)), []);
    assert.equal((await request(endpoint, admin, "POST", condition, { Origin: "https://invalid.test" })).status, 403);
    assert.equal((await request(endpoint, admin, "POST", { ...condition, regionKey: "not-an-exact-region" })).status, 400);
    const started = await request(endpoint, admin, "POST", condition);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const duplicate = await request(endpoint, admin, "POST", condition);
    assert.equal(duplicate.data.job.id, started.data.job.id, "double-clicks reuse an active job");
    let result;
    for (let i = 0; i < 200; i++) {
      result = await request(query, admin);
      if (!["queued", "running"].includes(result.data.job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(result.data.job.status, "complete", JSON.stringify(result.data));
    assert.equal(result.data.job.progress.completed, 6);
    assert.equal(result.data.job.steps[0].zeroValuesObserved, 2, "normal zero remains observed");
    const calls = JSON.parse(await fs.readFile(auditFile));
    assert.equal(calls.length, 6); assert.ok(!calls.includes("FORBIDDEN_EXTERNAL_FETCH"));
    const report = await request("/api/monthly-reports/preview", admin, "POST", {
      type: "region", targetId: condition.regionKey, month: condition.month, cutoffDate: condition.cutoffDate
    });
    assert.equal(report.status, 200, JSON.stringify(report.data));
    const visitors = report.data.context.sources.find(source => source.key === "tourism_visitors");
    assert.equal(visitors.period, "202608"); assert.equal(visitors.rows[0].value, 0);
    const trend = report.data.context.sources.find(source => source.key === "naver_search_trend");
    assert.match(trend.label, /포천글램핑/); assert.equal(trend.rows[0].value, 0); assert.equal(trend.rows[0].unit, "상대지수");
    assert.equal(result.data.searchTrendConnection.configured, true);
    const resource = report.data.context.sources.find(source => source.key === "tourism_resource");
    assert.equal(resource.rows[0].value, 12);
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile)), calls, "report generation only reads saved provider values");
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "regional_report_preparation", "jobs.json")));
    assert.equal(persisted.jobs[`${condition.regionKey}|${condition.month}`].status, "complete");
    assert.equal((await request("/api/crawl-status", admin)).data.active, false);
    console.log("Regional preparation API passed: admin access, deduplication, six sources, observed zeros, persistence and cache-only report integration; external network disabled.");
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
