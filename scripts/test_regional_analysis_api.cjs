"use strict";
// A real local application server with synthetic providers. All outbound fetch
// calls in the child are forbidden; production files and schedules are unused.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

async function main() {
  const root = path.resolve(__dirname, ".."), directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-analysis-api-"));
  await seedMonthlyReportFixture(directory);
  const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`, auditFile = path.join(directory, "audit.json"), preload = path.join(directory, "providers.cjs");
  await fs.writeFile(preload, `
    const fs = require('node:fs'), calls = [];
    const record = key => { calls.push(key); fs.writeFileSync(${JSON.stringify(auditFile)}, JSON.stringify(calls)); };
    fs.writeFileSync(${JSON.stringify(auditFile)}, '[]');
    global.fetch = async () => { record('FORBIDDEN_EXTERNAL_FETCH'); throw new Error('Outbound provider request forbidden'); };
    // Unrelated industry bootstrap also reads regional context; isolate this
    // endpoint's foreground work from that independent startup maintenance.
    const industry = require(${JSON.stringify(path.join(root, "scripts/lib/industry_analysis.cjs"))}), originalIndustry = industry.createIndustryAnalysisService;
    industry.createIndustryAnalysisService = options => { const service = originalIndustry({...options,autoStart:false}); service.bootstrap = async () => {}; return service; };
    const integrated = require(${JSON.stringify(path.join(root, "scripts/lib/company_integrated_db.cjs"))}), originalIntegrated = integrated.createCompanyIntegratedDb;
    integrated.createCompanyIntegratedDb = options => { const service = originalIntegrated({...options,autoStart:false}); service.bootstrap = async () => {}; return service; };
    const tourism = require(${JSON.stringify(path.join(root, "scripts/tourism_collector.cjs"))}), original = tourism.createCollector;
    const shift = (m,n) => { const [y,x]=m.split('-').map(Number); return new Date(Date.UTC(y,x-1+n,1)).toISOString().slice(0,7); };
    tourism.createCollector = options => {
      const collector = original(options);
      ['collectVisitorHistory','collectDemandStrengthHistory','collectResourceDemandHistory','collectDiversityHistory'].forEach((method,i)=>{
        collector[method] = async input => {
          record(method + (input.collectMissing ? ':refresh' : ':cache'));
          const end = input.endYearMonth.slice(0,4)+'-'+input.endYearMonth.slice(4);
          const series = Array.from({length:input.months},(_,j)=>({yearMonth:shift(end,j+1-input.months).replace('-',''),status:'complete',
            collectedAt:'2026-10-01T00:00:00Z',averageDailyVisitors:45048+j,visitorDays:1351440+j,stayOverall:75.2,spendOverall:60,
            values:{service:30,culture:40,visitor:50,spend:60,international:70}}));
          return {period:{endYearMonth:input.endYearMonth},...(i===0?{regions:[{regionKey:input.regionKey,series}]}:{region:{regionKey:input.regionKey},series}),
            collection:{networkAttemptedMonths:input.collectMissing?1:0,operationCallsAttempted:input.collectMissing?2:0}};
        };
      });
      return collector;
    };
    const kosis = require(${JSON.stringify(path.join(root, "scripts/lib/kosis.cjs"))});
    const regional = regionKey => ({region:{regionKey},status:'ready',datasets:kosis.DEFINITIONS.map(d=>({key:d.key,label:d.label,periodType:d.periodType,
      period:d.periodType==='Y'?'2024':'202608',status:'ready',retrievedAt:'2026-10-01T00:00:00Z',rows:d.metrics.flatMap(m=>(d.breakdowns||[null]).map(b=>({key:b?.key||m.key,label:b?.label||m.label,unit:m.unit,value:100,status:'observed'})))}))});
    kosis.createKosisService = () => ({getRegion:async key=>{record('kosis:cache');return regional(key);},refreshRegion:async key=>{record('kosis:refresh');return regional(key);},status:async()=>({configured:false})});
    const trends = require(${JSON.stringify(path.join(root, "scripts/lib/regional_search_trends.cjs"))});
    const trend = input => ({...input,status:'ready',configured:true,keyword:'포천글램핑',partialMonth:false,startDate:shift(input.month,1-(input.months||12))+'-01',endDate:input.month+'-28',
      retrievedAt:'2026-10-01T00:00:00Z',series:Array.from({length:input.months||12},(_,i)=>({period:shift(input.month,i+1-(input.months||12))+'-01',value:i===0?0:40+i,status:'observed'}))});
    trends.createRegionalSearchTrendService = () => ({get:async input=>{record('search:cache');return trend(input);},refresh:async input=>{record('search:refresh');return {...trend(input),networkAttempted:true};},status:async()=>({configured:true})});
    const special = require(${JSON.stringify(path.join(root, "scripts/lib/special_days.cjs"))}), originalSpecial = special.createSpecialDaysService;
    const calendar = (year, networkAttempted) => ({year,networkAttempted,configured:true,status:'ready',categories:{holidays:{kind:'holidays',operation:'getRestDeInfo',status:'ready',stale:false,
      updatedAt:'2026-10-01T00:00:00Z',items:[{date:String(year)+'-10-09',name:'시험 공휴일',kind:'holidays',isHoliday:true}]}}});
    special.createSpecialDaysService = options => {
      const service = originalSpecial(options);
      service.getCachedYear = async year => {record('special:cache:'+year);return calendar(year,false);};
      service.getYear = async year => {record('special:refresh:'+year);return calendar(year,true);};
      return service;
    };
  `);
  let child, output = "";
  async function start() {
    child = spawn(process.execPath, ["--require", preload, "scripts/glamping_app_server.cjs"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory, OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "regional-local-admin", GLAMPING_ADMIN_PASSWORD: "regional-fixture-only", GLAMPING_B2B_ENABLED: "0",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" } });
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error("Fixture server did not start: " + output.slice(-2000));
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Fixture server startup timeout");
  }
  async function stop() { if (!child || child.exitCode !== null) return; const exited = once(child, "exit"); child.kill(); await exited; }
  async function request(route, cookie = "", body) {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function login() {
    const result = await request("/api/login", "", { username: "regional-local-admin", password: "regional-fixture-only" });
    assert.equal(result.status, 200); return result.headers.get("set-cookie").split(";")[0];
  }
  const scope = { regionKey: "kr_gyeonggi_pocheon", month: "2026-08", months: 13 };
  const query = "/api/regional-analysis?" + new URLSearchParams(scope);
  const outlookScope = { regionKey: scope.regionKey, months: 13 };
  const outlookQuery = "/api/regional-outlook?" + new URLSearchParams(outlookScope);
  const currentMonth = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
  const audit = async () => JSON.parse(await fs.readFile(auditFile));
  async function waitOutlook(cookie) {
    let latest;
    for (let i = 0; i < 240; i++) {
      latest = await request(outlookQuery, cookie);
      if (latest.data.snapshot && latest.data.job && !["queued", "running"].includes(latest.data.job.status)) {
        assert.equal(latest.data.job.status, "completed", JSON.stringify(latest.data));
        return latest;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Outlook fixture calculation timeout: " + JSON.stringify(latest?.data));
  }
  try {
    await start();
    assert.equal((await request(query)).status, 401);
    assert.equal((await request(outlookQuery)).status, 401);
    assert.equal((await request("/api/regional-outlook/refresh", "", outlookScope)).status, 401);
    let cookie = await login();
    assert.equal((await request(query, cookie)).data.snapshot, null);
    assert.equal((await request(outlookQuery, cookie)).data.snapshot, null);
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile)), []);
    const started = await request("/api/regional-analysis/refresh", cookie, { ...scope, collectMissing: false });
    assert.equal(started.status, 202);
    let result;
    for (let i = 0; i < 160; i++) {
      result = await request(query, cookie);
      if (result.data.snapshot && !["queued", "running"].includes(result.data.job?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(result.data.snapshot.status, "ready", JSON.stringify(result.data));
    assert.equal(result.data.snapshot.groups.length, 6); assert.equal(result.data.policy.enabled, false);
    // Saving regional indicators schedules a local outlook build. Wait for
    // that independent queue before asserting that foreground GETs do nothing.
    let outlook = await waitOutlook(cookie);
    assert.equal(outlook.data.snapshot.asOfMonth, currentMonth());
    assert.equal(outlook.data.snapshot.targets.length, 2);
    assert.equal(outlook.data.snapshot.targets[0].period, currentMonth());
    assert.ok(outlook.data.snapshot.metrics.length > 0);
    assert.equal(outlook.data.snapshot.calendar.source.operation, "getRestDeInfo");
    assert.equal(outlook.data.snapshot.calendar.cacheOnly, true);
    let outlookResultId = outlook.data.snapshot.resultId;
    let resultId = result.data.snapshot.resultId;
    const before = JSON.parse(await fs.readFile(auditFile));
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(query, cookie)).data.snapshot.resultId, resultId);
      assert.equal((await request(outlookQuery, cookie)).data.snapshot.resultId, outlookResultId);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile)), before, "saved GET cannot invoke any source reader");
    assert.ok(before.every(value => !value.endsWith(":refresh") && value !== "FORBIDDEN_EXTERNAL_FETCH"));
    assert.ok(!before.some(value => value.startsWith("special:refresh:")), "Automatic and cache-only outlook builds never request holiday providers");
    const cacheBuild = await request("/api/regional-outlook/refresh", cookie, { ...outlookScope, collectMissing: false });
    assert.equal(cacheBuild.status, 202);
    outlook = await waitOutlook(cookie);
    assert.equal(outlook.data.snapshot.resultId, outlookResultId, "Unchanged indicator/calendar values reuse the saved immutable outlook");
    assert.equal(outlook.data.job.unchanged, true);
    assert.ok(!(await audit()).some(value => value.startsWith("special:refresh:") || value.endsWith(":refresh")));
    assert.equal((await request("/api/regional-outlook/refresh", cookie, { ...outlookScope, month: "2026-08" })).status, 400, "Historical outlooks are read-only");
    const refreshed = await request("/api/regional-analysis/refresh", cookie, { ...scope, collectMissing: true });
    assert.equal(refreshed.status, 202);
    for (let i = 0; i < 160; i++) {
      result = await request(query, cookie);
      if (result.data.job && !["queued", "running"].includes(result.data.job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(result.data.job.status, "completed", JSON.stringify(result.data));
    assert.equal(result.data.snapshot.status, "ready");
    await waitOutlook(cookie);
    const afterRefresh = JSON.parse(await fs.readFile(auditFile));
    assert.ok(afterRefresh.includes("search:refresh"), "only explicit refresh invokes source preparation");
    assert.ok(!afterRefresh.includes("FORBIDDEN_EXTERNAL_FETCH"));
    resultId = result.data.snapshot.resultId;
    const explicitOutlook = await request("/api/regional-outlook/refresh", cookie, { ...outlookScope, collectMissing: true });
    assert.equal(explicitOutlook.status, 202);
    outlook = await waitOutlook(cookie);
    assert.equal(outlook.data.snapshot.status, "ready");
    assert.ok((await audit()).some(value => value.startsWith("special:refresh:")), "Only explicit forecast refresh can request annual holiday providers");
    assert.ok(!(await audit()).includes("FORBIDDEN_EXTERNAL_FETCH"));
    outlookResultId = outlook.data.snapshot.resultId;
    const settledAudit = await audit();
    assert.equal((await request(outlookQuery, cookie)).data.snapshot.resultId, outlookResultId);
    assert.deepEqual(await audit(), settledAudit, "Saved forecast GET has no source/preparation/calendar side effects");
    const policy = await request("/api/regional-analysis/policy", cookie, { regionKey: scope.regionKey, months: 13, enabled: false, hour: 9, minute: 0, intervalHours: 24 });
    assert.equal(policy.status, 200); assert.equal(policy.data.policy.enabled, false); assert.equal(policy.data.policy.nextRunAt, null);
    await stop(); await start(); cookie = await login();
    assert.equal((await request(query, cookie)).data.snapshot.resultId, resultId, "durable result survives application restart");
    assert.equal((await request(outlookQuery, cookie)).data.snapshot.resultId, outlookResultId, "Saved outlook survives full application restart without rebuilding");
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile)), [], "restart and GET do not rebuild sources");
    if (process.argv.includes("--preview")) {
      // Prepare the default completed-month view entirely from fixtures.
      await request("/api/regional-analysis/refresh", cookie, { regionKey: scope.regionKey, months: 13, collectMissing: false });
      await waitOutlook(cookie);
      await request("/api/regional-outlook/refresh", cookie, { ...outlookScope, collectMissing: false });
      await waitOutlook(cookie);
      console.log(`LOCAL_PREVIEW_URL=${base}/admin`);
      console.log("Synthetic local account: regional-local-admin / regional-fixture-only");
      await new Promise(resolve => setTimeout(resolve, 900000));
    }
    console.log("regional analysis and outlook real-server API checks passed (synthetic providers/calendars; external fetches forbidden)");
  } finally {
    await stop(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
