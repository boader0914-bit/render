const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "special-days-api-"));
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(temp, "provider-fixture.cjs");
  await fs.writeFile(preload, `
    global.fetch = async function(input) {
      const u = new URL(String(input));
      if (u.hostname !== 'apis.data.go.kr' || !u.pathname.includes('/SpcdeInfoService/')) {
        throw new Error('External requests blocked by test');
      }
      const holiday = /getRestDeInfo|getHoliDeInfo/.test(u.pathname);
      return {ok:true,status:200,text:async()=>JSON.stringify({response:{
        header:{resultCode:'00',resultMsg:'NORMAL SERVICE.'},
        body:{numOfRows:100,pageNo:1,totalCount:1,items:{item:{
          locdate:Number(u.searchParams.get('solYear')+'1005'),dateName:holiday?'대체공휴일':'시험 기념일',
          isHoliday:holiday?'Y':'N',seq:1,dateKind:holiday?'01':'02'
        }}}
      }})};
    };
  `);
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: temp, OUTPUTS_DIR: path.join(temp, "outputs"), CONFIG_DIR: path.join(temp, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off",
      GLAMPING_ADMIN_USER: "holiday-test-admin", GLAMPING_ADMIN_PASSWORD: "holiday-test-password",
      GLAMPING_B2B_USER: "holiday-test-member", GLAMPING_B2B_PASSWORD: "holiday-test-password", GLAMPING_B2B_ENABLED: "1",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      DATA_GO_KR_SPECIAL_DAYS_SERVICE_KEY: "special-days-test-secret"
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const request = async (route, cookie = "", options = {}) => {
    const response = await fetch(base + route, { ...options,
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes("special-days-test-secret"), "API must not expose service key");
    return { status: response.status, data, response };
  };
  const login = async (username) => {
    const result = await request("/api/login", "", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "holiday-test-password" }) });
    assert.equal(result.status, 200);
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error("Server failed: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "test server should start");
    const routes = ["/api/settings/special-days?year=2026", "/api/special-days?year=2026"];
    for (const route of routes) assert.equal((await request(route)).status, 401);
    const member = await login("holiday-test-member");
    for (const route of routes) assert.equal((await request(route, member)).status, 403);
    assert.equal((await request("/api/settings/special-days/refresh", member, { method: "POST" })).status, 403);
    const admin = await login("holiday-test-admin");
    const initial = await request(routes[0], admin);
    assert.equal(initial.status, 200);
    assert.equal(initial.data.configured, true);
    assert.deepEqual(initial.data.cachedYears, [], "status must not collect data");
    assert.equal((await request("/api/special-days?year=../2026", admin)).status, 400);
    const result = await request(routes[1], admin);
    assert.equal(result.status, 200);
    assert.equal(result.data.status, "ready");
    assert.equal(Object.keys(result.data.categories).length, 5);
    assert.equal(result.data.holidays.length, 1, "national-day duplicate must not double-count holidays");
    assert.equal(result.data.holidays[0].date, "2026-10-05");
    assert.equal(result.data.categories.anniversaries.items[0].isHoliday, false);
    const cached = await request(routes[1], admin);
    assert.equal(cached.data.networkAttempted, false, "fresh cache must avoid external calls");
    const post = (body, headers = {}) => request("/api/settings/special-days/refresh", admin, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body)
    });
    assert.equal((await post({ year: 2026, serviceKey: "injected" })).status, 400);
    assert.equal((await post({ year: 2026, endpoint: "https://example.invalid" })).status, 400);
    assert.equal((await post({ year: 2026 }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post({ year: 2026 }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ year: "2026-10" })).status, 400);
    const refreshed = await post({ year: 2026 });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.status, "ready");
    assert.equal(refreshed.data.networkAttempted, true);
    const status = await request(routes[0], admin);
    assert.equal(status.data.yearStatus.status, "ready");
    assert.equal(status.data.cachedYears.length, 1);
    console.log("special-days API: auth, key isolation, validation, cache, refresh, and holiday distinction passed");
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("special-days-api-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
