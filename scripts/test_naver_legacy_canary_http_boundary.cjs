"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const ADMIN_USER = "naver-canary-admin";
const ADMIN_PASSWORD = "NaverCanaryAdmin!123";
const B2B_USER = "naver-canary-b2b";
const B2B_PASSWORD = "NaverCanaryB2B!123";
const ADMIN_AGENT = "naver-canary-admin-fixture";
const B2B_AGENT = "naver-canary-b2b-fixture";

const networkGuard = installFixtureNetworkGuard({
  allowLocalhost: true,
  label: "NAVER legacy canary HTTP boundary fixtures"
});

function safeTempRoot(value) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(value));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function safeChildEnvironment(overrides = {}) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

async function writeChildPreload(runtimeRoot, crawlerAttemptFile) {
  const preloadPath = path.join(runtimeRoot, "naver_canary_network_guard.cjs");
  const guardPath = path.join(ROOT, "scripts", "fixture_network_guard.cjs");
  const crawlerPath = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");
  const source = [
    '"use strict";',
    `require(${JSON.stringify(guardPath)}).installFixtureNetworkGuard({ allowLocalhost: true, label: "NAVER canary HTTP child" });`,
    'const fs = require("node:fs");',
    'const childProcess = require("node:child_process");',
    "const nativeSpawn = childProcess.spawn;",
    "childProcess.spawn = function guardedSpawn(command, args, options) {",
    `  if (Array.isArray(args) && args.some((value) => String(value) === ${JSON.stringify(crawlerPath)})) {`,
    `    fs.appendFileSync(${JSON.stringify(crawlerAttemptFile)}, "crawler-spawn-attempted\\n", "utf8");`,
    '    const error = new Error("Crawler child must not start from the disabled canary route");',
    '    error.code = "FIXTURE_CRAWLER_SPAWN_BLOCKED";',
    "    throw error;",
    "  }",
    "  return nativeSpawn.call(this, command, args, options);",
    "};"
  ].join("\n");
  await fsp.writeFile(preloadPath, `${source}\n`, "utf8");
  return preloadPath;
}

function spawnServer(port, runtimeRoot, preloadPath) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: safeChildEnvironment({
      NODE_ENV: "test",
      NODE_OPTIONS: `--require=${preloadPath}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      RENDER: "",
      RENDER_SERVICE_NAME: "",
      RENDER_EXTERNAL_URL: "",
      RENDER_EXTERNAL_HOSTNAME: "",
      V2_PREVIEW_DATA_ROOT: runtimeRoot,
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: ADMIN_USER,
      GLAMPING_ADMIN_PASSWORD: ADMIN_PASSWORD,
      GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: B2B_USER,
      GLAMPING_B2B_PASSWORD: B2B_PASSWORD
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-12000); });
  return { child, stderr: () => stderr };
}

async function waitForHealth(baseUrl, server) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`fixture server exited\n${server.stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`fixture server health timeout\n${server.stderr()}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => server.child.once("exit", resolve));
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { response, body, text };
}

async function login(baseUrl, username, password, userAgent) {
  const result = await jsonRequest(baseUrl, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ username, password })
  });
  assert.equal(result.response.status, 200);
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/u);
  return cookie;
}

function sessionHeaders(cookie, userAgent, extra = {}) {
  return { cookie, "user-agent": userAgent, accept: "application/json", ...extra };
}

async function runtimeFingerprint(runtimeRoot) {
  const rows = [];
  async function visit(current) {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(runtimeRoot, absolute).replace(/\\/gu, "/");
      if (entry.isDirectory()) await visit(absolute);
      else {
        const bytes = await fsp.readFile(absolute);
        rows.push(`${relative}:${crypto.createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  }
  await visit(runtimeRoot);
  return rows;
}

async function main() {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-http-"));
  assert.equal(safeTempRoot(runtimeRoot), true);
  const crawlerAttemptFile = path.join(runtimeRoot, "crawler-attempts.log");
  const preloadPath = await writeChildPreload(runtimeRoot, crawlerAttemptFile);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, runtimeRoot, preloadPath);
  try {
    await waitForHealth(baseUrl, server);
    const adminCookie = await login(baseUrl, ADMIN_USER, ADMIN_PASSWORD, ADMIN_AGENT);
    const b2bCookie = await login(baseUrl, B2B_USER, B2B_PASSWORD, B2B_AGENT);
    const baseline = await runtimeFingerprint(runtimeRoot);

    const anonymous = await jsonRequest(baseUrl, "/api/admin/provider-canary/naver-place-main/status", {
      headers: { accept: "application/json", "user-agent": "naver-canary-anonymous-fixture" }
    });
    assert.equal(anonymous.response.status, 401);

    const b2b = await jsonRequest(baseUrl, "/api/admin/provider-canary/naver-place-main/status", {
      headers: sessionHeaders(b2bCookie, B2B_AGENT)
    });
    assert.equal(b2b.response.status, 403);

    const admin = await jsonRequest(baseUrl, "/api/admin/provider-canary/naver-place-main/status", {
      headers: sessionHeaders(adminCookie, ADMIN_AGENT)
    });
    assert.equal(admin.response.status, 200);
    assert.equal(admin.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(admin.body, {
      strategy: "legacy_candidate",
      phase: "naver_place_rank_main",
      collectorScope: "main_place_only",
      enabled: false,
      actualCallsEnabled: false,
      externalCallApproved: false,
      providerHealthWriteApproved: false,
      resultWriteApproved: false,
      maxProviderAttempts: 1,
      authorizedCallCount: 0,
      executedCallCount: 0,
      blocker: "feature_gate_disabled",
      planVersion: "naver-legacy-preview-canary.v1"
    });

    const disabledPost = await jsonRequest(baseUrl, "/api/admin/provider-canary/naver-place-main/execute", {
      method: "POST",
      headers: sessionHeaders(adminCookie, ADMIN_AGENT, { "content-type": "application/json" }),
      body: "{"
    });
    assert.equal(disabledPost.response.status, 503);
    assert.equal(disabledPost.body.code, "NAVER_LEGACY_CANARY_DISABLED");
    assert.equal(disabledPost.body.retryable, false);
    assert.doesNotMatch(disabledPost.text, /keyword|query|url|header|cookie|credential|raw|placeId|company|address/iu);

    const after = await runtimeFingerprint(runtimeRoot);
    assert.deepEqual(after, baseline, "Canary GET and disabled POST must not write runtime files");
    assert.equal(fs.existsSync(crawlerAttemptFile), false, "Canary routes must not spawn the crawler child");
    assert.equal(fs.existsSync(path.join(runtimeRoot, "provider_health", "naver_place_search.json")), false);
    assert.equal(networkGuard.blockedAttempts(), 0);
  } finally {
    await stopServer(server);
    if (safeTempRoot(runtimeRoot)) await fsp.rm(runtimeRoot, { recursive: true, force: true });
    networkGuard.restore();
  }
  console.log("NAVER legacy canary admin HTTP, disabled gate, and no-store boundary tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
