const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createMasterDbIncrementalProcessor } = require("./master_db_incremental.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(__dirname, "glamping_app_server.cjs");
const EXPECTED_KEYWORDS = [
  "경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑", "충남글램핑",
  "전남글램핑", "전북글램핑", "대전글램핑", "서울근교글램핑", "경주글램핑",
  "여수글램핑", "가평글램핑", "포천글램핑"
];
const ADMIN = { username: "daily-test-admin", password: "temporary-daily-admin-fixture" };
const B2B = { username: "daily-test-b2b", password: "temporary-daily-b2b-fixture" };

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(baseUrl, pathname, cookie = "", options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    signal: AbortSignal.timeout(5000)
  });
  return { response, body: await response.json() };
}

async function login(baseUrl, account) {
  const result = await request(baseUrl, "/api/login", "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account)
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/);
  return cookie;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Test server exited before readiness.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Startup is still in progress. */ }
    await delay(50);
  }
  throw new Error(`Test server readiness timed out.\n${output.join("")}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function writeExecutionGuard(tempRoot) {
  const guardPath = path.join(tempRoot, "forbid-external-and-crawler.cjs");
  const attemptsPath = path.join(tempRoot, "forbidden-attempts.log");
  // The server is real. Only unrelated external IO and crawler process launches are forbidden.
  // This protects the test even if a regression accidentally enables a scheduler execution.
  await fsp.writeFile(guardPath, `
const fs = require('node:fs');
function denied(operation) {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, operation + '\\n');
  throw new Error('Integration test forbids ' + operation);
}
const childProcess = require('node:child_process');
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  childProcess[method] = () => denied('subprocess.' + method);
}
for (const protocol of ['node:http','node:https']) {
  const transport = require(protocol);
  transport.request = () => denied(protocol + '.request');
  transport.get = () => denied(protocol + '.get');
}
globalThis.fetch = () => denied('fetch');
`, "utf8");
  return { guardPath, attemptsPath };
}

async function assertNoDerivedIngest(tempRoot) {
  const dataDir = path.join(tempRoot, "partial-ingest-fixture");
  const outputsDir = path.join(dataDir, "outputs");
  const runId = "20260920_140000_partial_scheduled_fixture";
  const runDir = path.join(outputsDir, runId);
  const databasePath = path.join(dataDir, "master_db", "preserved.sqlite");
  const manifestPath = path.join(runDir, "manifest.json");
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(path.dirname(databasePath), { recursive: true });
  // A quality hold must happen before the database is opened, even before schema/bootstrap.
  const originalDb = Buffer.from("existing-database-preservation-fixture\n");
  await fsp.writeFile(databasePath, originalDb);
  const manifestText = `${JSON.stringify({
    schemaVersion: 2,
    keyword: "포천글램핑",
    scheduledCollection: true,
    collectionQuality: { status: "partial", reason: "booking_results_incomplete", counts: {} },
    files: {}
  }, null, 2)}\n`;
  await fsp.writeFile(manifestPath, manifestText);
  const processor = createMasterDbIncrementalProcessor({ dataDir, outputsDir, databasePath });
  assert.throws(() => processor.ingestNaverRun({ runId, runDir }), {
    code: "scheduled_collection_quality_hold"
  });
  assert.deepEqual(await fsp.readFile(databasePath), originalDb);
  assert.equal(await fsp.readFile(manifestPath, "utf8"), manifestText);
  assert.equal(fs.existsSync(path.join(dataDir, "company_master")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "history")), false);
  assert.deepEqual(await fsp.readdir(path.dirname(databasePath)), ["preserved.sqlite"]);
}

async function main() {
  const tempBase = await fsp.realpath(os.tmpdir());
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "staydatalab-daily-integration-"));
  let child;
  try {
    await assertNoDerivedIngest(tempRoot);
    const appData = path.join(tempRoot, "server-data");
    const configDir = path.join(appData, "config");
    const configFile = path.join(configDir, "daily_keyword_collection.json");
    await fsp.mkdir(configDir, { recursive: true });
    const { guardPath, attemptsPath } = await writeExecutionGuard(tempRoot);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const output = [];
    child = spawn(process.execPath, ["--require", guardPath, SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        PORT: String(port), HOST: "127.0.0.1",
        DATA_DIR: appData, OUTPUTS_DIR: path.join(appData, "outputs"), CONFIG_DIR: configDir,
        MASTER_DB_PATH: path.join(appData, "master_db", "test.sqlite"),
        MASTER_DB_WRITE_MODE: "off",
        SEED_OUTPUTS_FROM_REPO: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0",
        TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
        GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
        GLAMPING_B2B_USER: B2B.username, GLAMPING_B2B_PASSWORD: B2B.password,
        GLAMPING_B2B_ENABLED: "1",
        RENDER_GIT_COMMIT: "daily-collection-integration-fixture"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => output.push(String(chunk)));
    child.stderr.on("data", chunk => output.push(String(chunk)));
    await waitForServer(baseUrl, child, output);

    const unauthenticated = await request(baseUrl, "/api/collection-schedule");
    assert.equal(unauthenticated.response.status, 401);
    const b2bCookie = await login(baseUrl, B2B);
    const forbidden = await request(baseUrl, "/api/collection-schedule", b2bCookie);
    assert.equal(forbidden.response.status, 403);
    const adminCookie = await login(baseUrl, ADMIN);

    const initial = await request(baseUrl, "/api/collection-schedule", adminCookie);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.enabled, false);
    assert.equal(initial.body.active, false);
    assert.equal(initial.body.nextRunAt, null);
    assert.equal(initial.body.config.enabled, false);
    assert.deepEqual(initial.body.config.keywords, EXPECTED_KEYWORDS);
    assert.deepEqual(initial.body.items, []);
    assert.equal(fs.existsSync(configFile), false, "Status reads must not create the configuration");

    const configuration = {
      version: 1, enabled: false, timezone: "Asia/Seoul", hour: 14, minute: 0,
      keywords: [...EXPECTED_KEYWORDS], bookingDays: 31, rankLimit: 20,
      minFreeBytes: 300 * 1024 * 1024
    };
    const configText = `${JSON.stringify(configuration, null, 2)}\n`;
    await fsp.writeFile(configFile, configText, "utf8");
    const configured = await request(baseUrl, "/api/collection-schedule", adminCookie);
    assert.equal(configured.response.status, 200);
    assert.deepEqual(configured.body.config, configuration, "The API must read the temp configuration file");
    assert.equal(configured.body.enabled, false);
    assert.equal(configured.body.active, false);
    assert.equal(configured.body.nextRunAt, null);
    assert.equal(configured.body.scheduledAt, `${configured.body.day}T05:00:00.000Z`);
    assert.equal(configured.body.blockedReason, "");
    assert.equal(configured.body.lastError, "");
    assert.equal(await fsp.readFile(configFile, "utf8"), configText, "Read-only API must preserve config bytes");

    await fsp.writeFile(configFile, "{invalid-json", "utf8");
    const invalid = await request(baseUrl, "/api/collection-schedule", adminCookie);
    assert.equal(invalid.response.status, 200);
    assert.equal(invalid.body.enabled, false);
    assert.equal(invalid.body.nextRunAt, null);
    assert.equal(invalid.body.config, null);
    assert.equal(invalid.body.blockedReason, "invalid_daily_collection_config");

    await fsp.writeFile(configFile, configText, "utf8");
    const recovered = await request(baseUrl, "/api/collection-schedule", adminCookie);
    assert.equal(recovered.body.lastError, "");
    assert.equal(recovered.body.config.minFreeBytes, configuration.minFreeBytes);
    assert.equal(recovered.body.enabled, false);
    const crawlStatus = await request(baseUrl, "/api/crawl-status", adminCookie);
    assert.equal(crawlStatus.response.status, 200);
    assert.equal(fs.existsSync(path.join(appData, "history", "daily_keyword_collection_state.json")), false);
    assert.equal(fs.existsSync(path.join(appData, "master_db", "test.sqlite")), false);
    assert.equal(fs.existsSync(attemptsPath), false, "No crawler launch or outbound request may be attempted");
    const outputNames = await fsp.readdir(path.join(appData, "outputs")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(outputNames, [], "This test must never create crawl results");
    console.log("daily collection integration: auth, disabled configuration, fail-closed recovery, and partial-ingest preservation passed; no collection or external IO");
  } finally {
    await stopChild(child);
    // Delete only this test's verified mkdtemp directory, never a supplied data path.
    const resolvedRoot = await fsp.realpath(tempRoot);
    const relative = path.relative(tempBase, resolvedRoot);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
    assert.equal(path.dirname(relative), ".");
    assert.ok(path.basename(relative).startsWith("staydatalab-daily-integration-"));
    await fsp.rm(resolvedRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
