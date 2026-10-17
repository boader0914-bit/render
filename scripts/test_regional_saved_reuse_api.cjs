"use strict";

// A real local application serving preserved snapshots from an isolated data
// directory. Actual observations are copied unchanged; no provider is mocked
// to make missing regions look observed. Without --actual, fixtures are plainly
// synthetic and must never be cited as production observations or timings.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { SCHEMA_VERSION, CALCULATION_VERSION, latestCompletedMonth } = require("./lib/regional_analysis_store.cjs");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const copy = value => JSON.parse(JSON.stringify(value));

function argumentsFor(argv) {
  const options = { actual: null, preview: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--preview") options.preview = true;
    else if (argv[index] === "--actual" && argv[index + 1] && !argv[index + 1].startsWith("--")) options.actual = path.resolve(argv[++index]);
    else throw new Error("Use --actual <saved-response.json> and optional --preview");
  }
  return options;
}

function syntheticPayload() {
  const month = latestCompletedMonth(new Date()), generatedAt = new Date().toISOString();
  const scope = { regionKey: "kr_gyeongnam_sancheong", label: "경상남도 산청군", month, months: 13 };
  const snapshot = { schemaVersion: SCHEMA_VERSION, calculationVersion: CALCULATION_VERSION,
    indicatorVersion: "synthetic-reuse-fixture", resultId: crypto.randomUUID(), generatedAt, builtAt: generatedAt,
    scope, status: "partial", networkAttempted: false, refreshRequested: false,
    summary: { total: 1, ready: 0, partial: 1, failed: 0, missing: 0, stale: 0 },
    groups: [{ key: "visitors", category: "tourism", label: "[모의] 지역 방문자", provider: "합성 자료", status: "partial", periodType: "M",
      latestPeriod: month, availableMonths: 1, expectedMonths: 13, metrics: [{ key: "averageDailyVisitors", label: "[모의] 일평균 방문자", unit: "명",
        rows: [{ period: month, value: 0, status: "observed" }, { period: "2020-01", value: null, status: "missing" }] }] }],
    notes: ["독립 API 계약 검수용 합성 자료입니다."], capabilities: {}, sourceFingerprint: "synthetic-saved-reuse-v1" };
  return { kind: "synthetic-local-api-fixture", regions: [
    { regionKey: scope.regionKey, response: { status: "partial", scope, snapshot } },
    { regionKey: "kr_admin_4413000000", response: { status: "missing", scope: { regionKey: "kr_admin_4413000000", label: "충청남도 천안시", month, months: 13 }, snapshot: null } }
  ] };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2)), repo = path.resolve(__dirname, "..");
  let actualBytes = null, payload;
  if (options.actual) {
    const stat = await fs.lstat(options.actual);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, "Saved response must be a bounded regular JSON file");
    actualBytes = await fs.readFile(options.actual); payload = JSON.parse(actualBytes.toString("utf8"));
  } else payload = syntheticPayload();
  assert.ok(Array.isArray(payload.regions) && payload.regions.length > 0 && payload.regions.length <= 20, "Expected bounded saved region responses");
  assert.equal(new Set(payload.regions.map(entry => entry.regionKey)).size, payload.regions.length, "Region fixtures must be distinct");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-saved-reuse-api-"));
  const regionalDirectory = path.join(directory, "regional_analysis"), auditFile = path.join(directory, "forbidden-actions.json");
  const preserved = [];
  let child = null, childOutput = "", externalAuditBefore;
  const adminUser = "regional-qa-" + crypto.randomBytes(4).toString("hex"), adminPassword = "local-only-" + crypto.randomBytes(10).toString("hex");
  async function write(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { flag: "wx" });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill(); await exited;
  }
  async function inventory() {
    const result = {};
    async function walk(directoryName) {
      let entries;
      try { entries = await fs.readdir(directoryName, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const file = path.join(directoryName, entry.name);
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) await walk(file);
        else result[path.relative(regionalDirectory, file)] = digest(await fs.readFile(file));
      }
    }
    await walk(regionalDirectory); return result;
  }
  try {
    await write(path.join(directory, "company_master", "companies.json"), { companies: {} });
    for (const entry of payload.regions) {
      const response = entry.response, scope = response?.scope;
      assert.equal(scope?.regionKey, entry.regionKey); assert.ok([13, 24].includes(scope.months));
      assert.match(scope.month, /^20\d{2}-(?:0[1-9]|1[0-2])$/);
      if (!response.snapshot) { assert.equal(response.status, "missing"); continue; }
      const snapshot = response.snapshot;
      assert.equal(snapshot.schemaVersion, SCHEMA_VERSION); assert.equal(snapshot.calculationVersion, CALCULATION_VERSION);
      assert.deepEqual(snapshot.scope, scope); assert.ok(Array.isArray(snapshot.groups));
      assert.match(snapshot.resultId, /^[a-f0-9-]{36}$/);
      const scopeKey = digest(JSON.stringify([snapshot.calculationVersion, scope.regionKey, scope.months, scope.month]));
      const resultFile = path.join(regionalDirectory, "results", scopeKey, snapshot.resultId + ".json");
      await write(resultFile, snapshot);
      await write(path.join(regionalDirectory, "latest", scopeKey + ".json"), { schemaVersion: SCHEMA_VERSION, scopeKey, resultId: snapshot.resultId, revisions: [] });
      preserved.push({ regionKey: scope.regionKey, resultId: snapshot.resultId, snapshot: copy(snapshot) });
    }
    assert.ok(preserved.length > 0, "At least one preserved snapshot is required");
    const beforeInventory = await inventory(), preload = path.join(directory, "read-only-preload.cjs");
    await fs.writeFile(preload, `"use strict";
const fs = require('node:fs'), calls = [];
const record = key => { calls.push(key); fs.writeFileSync(${JSON.stringify(auditFile)}, JSON.stringify(calls)); };
fs.writeFileSync(${JSON.stringify(auditFile)}, '[]');
global.fetch = async () => { record('FORBIDDEN_EXTERNAL_FETCH'); throw new Error('External fetch forbidden in saved-response preview'); };
const localFault = () => Object.assign(new Error('Local saved snapshot preview is read-only'), { code:'LOCAL_SAVED_PREVIEW_READ_ONLY',statusCode:403 });
// Keep the actual server routes and saved-store GET implementation. Disable
// unrelated startup workers and all provider/local refresh admissions only in
// this child, without modifying repository code or the preserved snapshots.
for (const [file, factory] of [['industry_analysis.cjs','createIndustryAnalysisService'],['company_integrated_db.cjs','createCompanyIntegratedDb']]) {
 const module = require(${JSON.stringify(path.join(repo, "scripts/lib"))}+'/'+file), original = module[factory];
 module[factory] = options => { const service=original({...options,autoStart:false});service.bootstrap=async()=>{};return service; };
}
const regional = require(${JSON.stringify(path.join(repo, "scripts/lib/regional_analysis_store.cjs"))}), originalRegional = regional.createRegionalAnalysisStore;
regional.createRegionalAnalysisStore = options => {
 const service=originalRegional({...options,autoStart:false,rollForward:false,onResultSaved:null});
 service.request=async()=>{record('FORBIDDEN_REGIONAL_REFRESH');throw localFault();};
 service.sourceChanged=async()=>({ignored:true,queued:0});service.tick=async()=>({queued:0});
 service.updatePolicy=async()=>{record('FORBIDDEN_POLICY_CHANGE');throw localFault();};return service;
};
const http = require('node:http'), originalServer=http.createServer;
http.createServer = function(...args) {
 const index=typeof args[0]==='function'?0:1, listener=args[index];
 if(typeof listener==='function') args[index]=function(req,res){
  const pathname=String(req.url||'').split('?')[0];
  if(req.method!=='GET' && !['/login','/api/login','/api/logout'].includes(pathname)){
   res.writeHead(403,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'로컬 저장자료 검수는 읽기 전용입니다.',code:'LOCAL_SAVED_PREVIEW_READ_ONLY'}));return;
  }
  return listener(req,res);
 };
 return originalServer.apply(this,args);
};
`);
    const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const childEnv = Object.fromEntries(["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(childEnv, { HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory, OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: adminUser, GLAMPING_ADMIN_PASSWORD: adminPassword, GLAMPING_B2B_ENABLED: "0",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" });
    child = spawn(process.execPath, ["--require", preload, "scripts/glamping_app_server.cjs"], { cwd: repo, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const recordOutput = chunk => { childOutput = (childOutput + String(chunk)).slice(-12000); };
    child.stdout.on("data", recordOutput); child.stderr.on("data", recordOutput);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated saved preview server failed to start: " + childOutput.slice(-1500));
      try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
      assert.ok(attempt < 199, "Isolated saved preview startup timeout"); await pause(50);
    }
    async function request(route, cookie = "", body) {
      const began = performance.now();
      const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15000),
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, data: await response.json(), elapsedMs: Math.round((performance.now() - began) * 10) / 10 };
    }
    const firstScope = payload.regions[0].response.scope;
    const queryFor = scope => "/api/regional-analysis?" + new URLSearchParams({ regionKey: scope.regionKey, month: scope.month, months: scope.months });
    assert.equal((await request(queryFor(firstScope))).status, 401, "Saved actual regional data still requires administrator authentication");
    // The real login page submits an HTML form to /login rather than /api/login.
    // Exercise that exact transport, cookie and administrator redirect too.
    const loginPage = await fetch(base + "/login");
    assert.equal(loginPage.status, 200); assert.match(await loginPage.text(), /action=["']\/login["']/);
    const formLogin = await fetch(base + "/login", { method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
      body: new URLSearchParams({ username: adminUser, password: adminPassword }) });
    assert.equal(formLogin.status, 302); assert.equal(formLogin.headers.get("location"), "/admin");
    assert.ok(formLogin.headers.get("set-cookie")); await formLogin.text();
    const formCookie = formLogin.headers.get("set-cookie").split(";")[0];
    const formRead = await request(queryFor(firstScope), formCookie);
    assert.equal(formRead.status, 200); assert.deepEqual(formRead.data.snapshot, payload.regions[0].response.snapshot);
    const adminPage = await fetch(base + "/admin", { headers: { Cookie: formCookie }, redirect: "manual" });
    assert.equal(adminPage.status, 200); assert.match(adminPage.headers.get("content-type"), /text\/html/);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /src="\/regional-evidence-review\.js"/);
    const reviewAsset = await fetch(base + "/regional-evidence-review.js", { headers: { Cookie: formCookie } });
    assert.equal(reviewAsset.status, 200); assert.match(reviewAsset.headers.get("content-type"), /javascript/);
    assert.match(await reviewAsset.text(), /regional-evidence-review-v1/);
    assert.equal((await request("/api/logout", formCookie, {})).status, 200);
    assert.equal((await request(queryFor(firstScope), formCookie)).status, 401, "The real logout endpoint invalidates only the form session");
    const login = await request("/api/login", "", { username: adminUser, password: adminPassword });
    assert.equal(login.status, 200); assert.ok(login.headers.get("set-cookie"));
    const cookie = login.headers.get("set-cookie").split(";")[0];
    externalAuditBefore = JSON.parse(await fs.readFile(auditFile, "utf8")); assert.deepEqual(externalAuditBefore, []);
    const samples = [];
    for (let iteration = 0; iteration < 3; iteration++) for (const entry of payload.regions) {
      const result = await request(queryFor(entry.response.scope), cookie);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data.snapshot, entry.response.snapshot, "Saved snapshot values and missingness must be copied without recalculation");
      assert.equal(result.data.policy.enabled, false); assert.equal(result.data.policy.nextRunAt, null);
      assert.equal(result.data.storage.errorCode, null);
      if (!entry.response.snapshot) {
        assert.equal(result.data.status, "missing"); assert.equal(result.data.snapshot, null, "No observation must never become a numeric zero");
      }
      samples.push({ iteration, regionKey: entry.regionKey, resultId: result.data.snapshot?.resultId || null, status: result.data.status, elapsedMs: result.elapsedMs });
    }
    const schedules = await request("/api/collection-schedule", cookie), rotation = await request("/api/collection-rotation", cookie);
    assert.equal(schedules.status, 200); assert.equal(schedules.data.enabled, false);
    assert.equal(rotation.status, 200); assert.equal(rotation.data.enabled ?? rotation.data.config?.enabled, false);
    const crawl = await request("/api/crawl-status", cookie), collector = await request("/api/collector-status", cookie);
    assert.equal(crawl.data.active, false); assert.equal(crawl.data.queueLength, 0);
    assert.equal(collector.status, 200); assert.equal(collector.data.workers.length, 3);
    for (const worker of collector.data.workers) {
      assert.equal(worker.crawl.active, false); assert.equal(worker.crawl.queueLength, 0);
      if (worker.configured) { assert.equal(worker.activeJobId, null); assert.equal(worker.queued, 0); }
    }
    assert.equal((await request("/api/regional-analysis/refresh", cookie, { ...firstScope, collectMissing: true })).status, 403,
      "Local preview rejects collection, refresh and schedule mutations before they reach an application handler");
    assert.deepEqual(await inventory(), beforeInventory, "Every saved regional pointer and immutable result remains unchanged");
    assert.deepEqual(JSON.parse(await fs.readFile(auditFile, "utf8")), [], "Saved reads and startup do not request providers or prepare sources");
    if (options.actual) assert.equal(digest(await fs.readFile(options.actual)), digest(actualBytes), "Original production export is immutable");
    console.log("REGIONAL_SAVED_REUSE_API=" + JSON.stringify({ mode: options.actual ? "preserved-production-snapshots" : "synthetic-contract-only",
      originalFileUnchanged: true, snapshotsDeepEqual: true, sourceFilesUnchanged: true, outboundRequests: 0,
      collectionExecuted: false, refreshExecuted: false, schedulesEnabled: false, htmlFormLoginVerified: true, logoutVerified: true, samples }));
    if (options.preview) {
      console.log("LOCAL_PREVIEW_URL=" + base + "/admin");
      console.log("LOCAL_PREVIEW_MODE=" + (options.actual ? "preserved production regional snapshots; read-only isolated copy" : "synthetic contract fixture; no production observations"));
      console.log("LOCAL_PREVIEW_ACCOUNT=" + adminUser + " / " + adminPassword);
      console.log("LOCAL_PREVIEW_DATA_DIR=" + directory);
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); process.stdin.removeListener("data", quit); process.stdin.pause(); resolve(); };
        const quit = value => { if (String(value).trim() === "q") finish(); };
        const timer = setTimeout(finish, 30 * 60 * 1000);
        process.stdin.on("data", quit); process.stdin.resume();
      });
      assert.deepEqual(await inventory(), beforeInventory, "UI preview cannot change the copied regional snapshots");
      assert.deepEqual(JSON.parse(await fs.readFile(auditFile, "utf8")), [], "UI saved-data inspection cannot request providers");
      if (options.actual) assert.equal(digest(await fs.readFile(options.actual)), digest(actualBytes));
    }
  } finally {
    await stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("regional-saved-reuse-api-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
