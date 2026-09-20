const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tourism-forecast-api-"));
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(temp, "provider-fixture.cjs");
  const failureFlag = path.join(temp, "fail-provider");
  await fs.writeFile(preload, `
    const fs = require('node:fs');
    global.fetch = async function(input) {
      const u = new URL(String(input));
      if (u.hostname !== 'apis.data.go.kr' || u.pathname !== '/B551011/TatsCnctrRateService/tatsCnctrRatedList') {
        throw new Error('External requests blocked by test');
      }
      if (fs.existsSync(${JSON.stringify(failureFlag)})) return {ok:false,status:503,text:async()=>''};
      const start = new Date(Date.now() + 9*60*60*1000);
      start.setUTCHours(0,0,0,0); start.setUTCDate(start.getUTCDate()-1);
      const rows = ['검증 관광지 A','검증 관광지 B'].flatMap((name,j)=>Array.from({length:30},(_,i)=>({
        baseYmd:new Date(start.getTime()+i*86400000).toISOString().slice(0,10).replaceAll('-',''),
        areaCd:u.searchParams.get('areaCd'),areaNm:'경기도',signguCd:u.searchParams.get('signguCd'),signguNm:'포천시',
        tAtsNm:name,cnctrRate:String(i+j)
      })));
      const pageNo=Number(u.searchParams.get('pageNo')),numOfRows=Number(u.searchParams.get('numOfRows'));
      return {ok:true,status:200,text:async()=>JSON.stringify({response:{
        header:{resultCode:'0000',resultMsg:'OK'},
        body:{numOfRows,pageNo,totalCount:rows.length,items:{item:rows.slice((pageNo-1)*numOfRows,pageNo*numOfRows)}}
      }})};
    };
  `);
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: temp, OUTPUTS_DIR: path.join(temp, "outputs"), CONFIG_DIR: path.join(temp, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off",
      GLAMPING_ADMIN_USER: "forecast-test-admin", GLAMPING_ADMIN_PASSWORD: "forecast-test-password",
      GLAMPING_B2B_USER: "forecast-test-member", GLAMPING_B2B_PASSWORD: "forecast-test-password", GLAMPING_B2B_ENABLED: "1",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      DATA_GO_KR_TOURISM_FORECAST_SERVICE_KEY: "forecast-test-secret"
    }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const request = async (route, cookie = "", options = {}) => {
    const response = await fetch(base + route, { ...options,
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes("forecast-test-secret"));
    return { status: response.status, data, response };
  };
  const login = async username => {
    const result = await request("/api/login", "", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "forecast-test-password" }) });
    assert.equal(result.status, 200);
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error("Server failed: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const statusRoute = "/api/settings/tourism-forecast";
    const regionRoute = "/api/tourism-forecast?areaCd=41&signguCd=41650";
    for (const route of [statusRoute, regionRoute]) assert.equal((await request(route)).status, 401);
    const member = await login("forecast-test-member");
    for (const route of [statusRoute, regionRoute]) assert.equal((await request(route, member)).status, 403);
    assert.equal((await request(statusRoute + "/refresh", member, { method: "POST" })).status, 403);
    const admin = await login("forecast-test-admin");
    const initial = await request(statusRoute, admin);
    assert.equal(initial.data.configured, true);
    assert.ok(initial.data.regions.some(r => r.areaCd === "41" && r.signguCd === "41650"));
    assert.deepEqual(initial.data.cachedRegions, [], "status must not fetch forecasts");
    assert.equal((await request("/api/tourism-forecast?areaCd=51&signguCd=41650", admin)).status, 400);
    assert.equal((await request(regionRoute + "&endpoint=https://example.invalid", admin)).status, 400);
    assert.equal((await request("/api/tourism-forecast?areaCd=41&signguCd=../41650", admin)).status, 400);
    const result = await request(regionRoute, admin);
    assert.equal(result.status, 200);
    assert.equal(result.data.status, "ready");
    assert.equal(result.data.destinations.length, 2);
    const first = result.data.destinations[0];
    assert.equal(first.series.length, 30);
    assert.equal(first.providerLagDays, 1);
    assert.equal(first.upcomingDayCount, 29, "yesterday's provider window must not be relabelled as 30 future days");
    assert.equal(first.series[0].value, 0, "a real zero must remain zero");
    assert.notEqual(first.id, result.data.destinations[1].id);
    const cached = await request(regionRoute, admin);
    assert.equal(cached.data.networkAttempted, false);
    const post = (body, headers = {}) => request(statusRoute + "/refresh", admin, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body)
    });
    const input = { areaCd: "41", signguCd: "41650" };
    assert.equal((await post({ ...input, serviceKey: "injected" })).status, 400);
    assert.equal((await post(input, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post(input, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ areaCd: "51", signguCd: "41650" })).status, 400);
    const refreshed = await post(input);
    assert.equal(refreshed.data.status, "ready");
    assert.equal(refreshed.data.networkAttempted, true);
    await fs.writeFile(failureFlag, "fixture only");
    const failed = await post(input);
    assert.equal(failed.data.status, "partial");
    assert.equal(failed.data.stale, true);
    assert.ok(failed.data.errors.length);
    assert.deepEqual(failed.data.destinations, refreshed.data.destinations, "failed refresh must preserve prior official rows");
    const status = await request(statusRoute, admin);
    assert.equal(status.data.cachedRegions.length, 1);
    console.log("tourism forecast API: auth, region validation, secret isolation, exact destination, provider dates, cache and failed refresh passed");
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("tourism-forecast-api-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
