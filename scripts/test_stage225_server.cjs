const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const ADMIN = { username: "stage225-admin", password: "stage225-admin-password" };
const BUSINESS = { username: "stage225-business", password: "stage225-business-password" };

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for Stage 225 server");
}

async function startServer({ port, flag }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `stage225-server-${port}-`));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    OUTPUTS_DIR: path.join(dataDir, "outputs"),
    CONFIG_DIR: path.join(dataDir, "config"),
    SEED_OUTPUTS_FROM_REPO: "0",
    GLAMPING_ADMIN_USER: ADMIN.username,
    GLAMPING_ADMIN_PASSWORD: ADMIN.password,
    GLAMPING_B2B_USER: BUSINESS.username,
    GLAMPING_B2B_PASSWORD: BUSINESS.password,
    GLAMPING_B2B_ENABLED: "1",
    V2_INTEGRATION_AUTH_ENABLED: ""
  };
  delete env.V2_UI_V3_ENABLED;
  if (flag !== undefined) env.V2_UI_V3_ENABLED = flag;
  const child = childProcess.spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForServer(baseUrl, child); } catch (error) { throw new Error(`${error.message}\n${output}`); }
  return { child, dataDir, baseUrl, output: () => output };
}

async function stopServer(instance) {
  if (instance.child.exitCode === null) instance.child.kill();
  await new Promise((resolve) => {
    if (instance.child.exitCode !== null) return resolve();
    instance.child.once("exit", resolve);
    setTimeout(resolve, 2_000).unref();
  });
  fs.rmSync(instance.dataDir, { recursive: true, force: true });
}

async function login(baseUrl, credentials) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
    redirect: "manual"
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie?.includes("glamping_datalab_session="));
  return cookie.split(";")[0];
}

async function request(baseUrl, pathname, cookie = "") {
  return fetch(`${baseUrl}${pathname}`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) }, redirect: "manual" });
}

(async () => {
  let off;
  let on;
  try {
    off = await startServer({ port: 3425, flag: undefined });
    const healthOff = await (await fetch(`${off.baseUrl}/api/health`)).json();
    const legacyFiles = ["/manifest.webmanifest", "/sw.js", "/offline.html", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
    for (const pathname of legacyFiles) {
      const response = await request(off.baseUrl, pathname);
      assert.equal(response.status, 200, `${pathname} status`);
      const expected = fs.readFileSync(path.join(ROOT, "web", pathname.replace(/^\//, "")));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `${pathname} must remain byte-identical with flag off`);
    }
    const legacyHtml = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8")
      .replace('href="/styles.css"', 'href="/styles.css?v=v2-20260714-region-keyword-readability-v22"')
      .replace('src="/app.js"', 'src="/app.js?v=v2-20260714-region-keyword-readability-v22"');
    const adminCookieOff = await login(off.baseUrl, ADMIN);
    const adminLegacy = await request(off.baseUrl, "/admin", adminCookieOff);
    assert.equal(adminLegacy.status, 200);
    assert.equal(await adminLegacy.text(), legacyHtml);
    const adminViewOff = await request(off.baseUrl, "/view", adminCookieOff);
    assert.equal(adminViewOff.status, 302);
    assert.equal(adminViewOff.headers.get("location"), "/admin");
    const businessCookieOff = await login(off.baseUrl, BUSINESS);
    const businessLegacy = await request(off.baseUrl, "/b2b", businessCookieOff);
    assert.equal(businessLegacy.status, 200);
    assert.equal(await businessLegacy.text(), legacyHtml);
    const wrongRoleOff = await request(off.baseUrl, "/admin", businessCookieOff);
    assert.equal(wrongRoleOff.status, 302);
    assert.equal(wrongRoleOff.headers.get("location"), "/b2b");
    await stopServer(off); off = null;

    on = await startServer({ port: 3426, flag: "true" });
    const healthOn = await (await fetch(`${on.baseUrl}/api/health`)).json();
    assert.deepEqual(healthOn, healthOff, "UI flag must not change unauthenticated health response");
    for (const pathname of ["/login", "/signup", "/activate", "/reset-password"]) {
      const response = await request(on.baseUrl, pathname);
      assert.equal(response.status, 200, `${pathname} V3 shell status`);
      assert.match(await response.text(), /data-v2-ui="v3"/);
    }
    const manifest = await request(on.baseUrl, "/manifest.webmanifest");
    assert.equal(JSON.parse(await manifest.text()).name, "숙박업 데이터랩 V2");
    const uiIndex = await (await request(on.baseUrl, "/login")).text();
    const assetPath = uiIndex.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
    assert.ok(assetPath, "Vite asset path is missing");
    assert.equal((await request(on.baseUrl, assetPath)).status, 200, "Vite assets must be public before login");

    const adminCookieOn = await login(on.baseUrl, ADMIN);
    const adminCompat = await request(on.baseUrl, "/admin", adminCookieOn);
    assert.equal(adminCompat.status, 302);
    assert.equal(adminCompat.headers.get("location"), "/admin/overview");
    const adminShell = await request(on.baseUrl, "/admin/overview", adminCookieOn);
    assert.equal(adminShell.status, 200);
    assert.match(await adminShell.text(), /data-v2-ui="v3"/);
    const viewOn = await request(on.baseUrl, "/view", adminCookieOn);
    assert.equal(viewOn.headers.get("location"), "/admin/overview");

    const businessCookieOn = await login(on.baseUrl, BUSINESS);
    const businessCompat = await request(on.baseUrl, "/b2b", businessCookieOn);
    assert.equal(businessCompat.status, 302);
    assert.equal(businessCompat.headers.get("location"), "/app/onboarding");
    const businessShell = await request(on.baseUrl, "/app/onboarding", businessCookieOn);
    assert.equal(businessShell.status, 200);
    assert.match(await businessShell.text(), /data-v2-ui="v3"/);
    const forbidden = await request(on.baseUrl, "/admin/overview", businessCookieOn);
    assert.equal(forbidden.status, 403, "business sessions must be blocked server-side from admin routes");
    const session = await fetch(`${on.baseUrl}/api/session`, { headers: { cookie: businessCookieOn } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).role, "b2b");

    console.log("Stage 225 flag-off legacy parity and flag-on server boundary checks passed");
  } finally {
    if (off) await stopServer(off);
    if (on) await stopServer(on);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
