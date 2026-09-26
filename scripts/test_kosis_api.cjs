"use strict";

// Route integration tests run an isolated server. Provider parsing, mapping and
// persistence are covered separately by test_kosis.cjs; no external API is called.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kosis-api-"));
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(temp, "fixture.cjs");
  const callFile = path.join(temp, "refresh-count.txt");
  const secret = "kosis-route-test-secret";
  await fs.writeFile(preload, `
    const Module = require('node:module');
    const fs = require('node:fs');
    const original = Module._load;
    global.fetch = async () => { throw new Error('External calls forbidden in API test'); };
    Module._load = function(request, parent, main) {
      if (request === './lib/kosis.cjs' && /glamping_app_server/.test(parent?.filename || '')) {
        return { createKosisService: ({ readApiKey }) => {
          let count = 0;
          const result = (regionKey, networkAttempted) => {
            if (!['kr_gyeonggi_pocheon'].includes(regionKey)) {
              const e = new Error('조회할 지역을 확인해 주세요.'); e.statusCode = 400; throw e;
            }
            return { configured: Boolean(readApiKey()), status: 'ready',
              region: { regionKey, name: '포천시' }, networkAttempted,
              datasets: [{ key: 'population', label: '주민등록 인구', status: 'ready',
                periodType: 'M', period: '202608', rows: [{ key: 'total', label: '인구', value: 0, unit: '명', status: 'observed' }] }] };
          };
          return {
            status: async () => ({ configured: Boolean(readApiKey()), envName: 'KOSIS_API_KEY', cachedRegionCount: 1 }),
            getRegion: async key => result(key, false),
            refreshRegion: async key => { const value = result(key, true); fs.writeFileSync(${JSON.stringify(callFile)}, String(++count)); return value; }
          };
        }};
      }
      return original.call(this, request, parent, main);
    };
  `);
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp,
      OUTPUTS_DIR: path.join(temp, "outputs"), CONFIG_DIR: path.join(temp, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off",
      GLAMPING_ADMIN_USER: "kosis-admin", GLAMPING_ADMIN_PASSWORD: "kosis-test-password",
      GLAMPING_B2B_USER: "kosis-member", GLAMPING_B2B_PASSWORD: "kosis-test-password", GLAMPING_B2B_ENABLED: "1",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      KOSIS_API_KEY: secret }
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const request = async (route, cookie = "", options = {}) => {
    const response = await fetch(base + route, { ...options,
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes(secret), "route must never reveal a key");
    return { response, status: response.status, data };
  };
  const login = async username => {
    const result = await request("/api/login", "", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "kosis-test-password" }) });
    assert.equal(result.status, 200);
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error("Fixture server failed: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const reads = ["/api/settings/kosis", "/api/kosis/region?regionKey=kr_gyeonggi_pocheon"];
    const refresh = "/api/settings/kosis/refresh";
    for (const route of reads) assert.equal((await request(route)).status, 401);
    assert.equal((await request(refresh, "", { method: "POST" })).status, 401);
    const member = await login("kosis-member");
    for (const route of reads) assert.equal((await request(route, member)).status, 403);
    assert.equal((await request(refresh, member, { method: "POST" })).status, 403);
    const admin = await login("kosis-admin");
    assert.equal((await request(reads[0], admin)).data.configured, true);
    const cached = await request(reads[1], admin);
    assert.equal(cached.data.networkAttempted, false);
    assert.equal(cached.data.datasets[0].rows[0].value, 0);
    assert.equal(cached.data.datasets[0].period, "202608");
    await assert.rejects(fs.stat(callFile), { code: "ENOENT" }, "GET must never refresh");
    for (const query of ["", "?regionKey=bad", "?regionKey=../test", "?regionKey=a&regionKey=b", "?regionKey=kr_gyeonggi_pocheon&refresh=true", "?regionKey=kr_gyeonggi_pocheon&apiKey=bad"]) {
      assert.equal((await request("/api/kosis/region" + query, admin)).status, 400);
    }
    const post = (body, headers = {}) => request(refresh, admin, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
    const input = { regionKey: "kr_gyeonggi_pocheon" };
    assert.equal((await post(input, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post(input, { "Content-Type": "text/plain" })).status, 415);
    for (const body of [null, [], {}, { regionKey: 123 }, { ...input, apiKey: "injected" }, { ...input, endpoint: "https://example.invalid" }]) {
      assert.equal((await post(body)).status, 400);
    }
    await assert.rejects(fs.stat(callFile), { code: "ENOENT" }, "rejected requests must never refresh");
    const result = await post(input);
    assert.equal(result.status, 200);
    assert.equal(result.data.networkAttempted, true);
    assert.equal(await fs.readFile(callFile, "utf8"), "1");
    await request(reads[0], admin);
    await request(reads[1], admin);
    assert.equal(await fs.readFile(callFile, "utf8"), "1", "subsequent GETs still cache only");
    assert.ok(!output.includes(secret), "server logs must not reveal key");
    console.log("KOSIS API: admin authorization, cache-only GET, explicit refresh, secret isolation and input/origin validation passed");
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("kosis-api-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
