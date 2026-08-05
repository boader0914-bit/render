"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { PROVIDER_ATTEMPT_LEASE_SECONDS } = require("./naver_provider_resilience.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const ADMIN_USER = "naver-resilience-admin";
const ADMIN_PASSWORD = "NaverResilienceAdmin!123";
const B2B_USER = "naver-resilience-b2b";
const B2B_PASSWORD = "NaverResilienceB2B!123";
const ADMIN_AGENT = "naver-resilience-admin-e2e";
const B2B_AGENT = "naver-resilience-b2b-e2e";
const RUN_ID = "pocheon_glamping_20260701_090000";
const CHECK_IN = "2026-08-07";
const CHECK_OUT = "2026-08-13";

const networkGuard = installFixtureNetworkGuard({
  allowLocalhost: true,
  label: "NAVER provider resilience E2E fixtures"
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
  const preloadPath = path.join(runtimeRoot, "naver_resilience_network_guard.cjs");
  const guardPath = path.join(ROOT, "scripts", "fixture_network_guard.cjs");
  const crawlerPath = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");
  const source = [
    '"use strict";',
    `require(${JSON.stringify(guardPath)}).installFixtureNetworkGuard({ allowLocalhost: true, label: "NAVER resilience child" });`,
    'const fs = require("node:fs");',
    'const childProcess = require("node:child_process");',
    "const nativeSpawn = childProcess.spawn;",
    "childProcess.spawn = function guardedSpawn(command, args, options) {",
    `  if (Array.isArray(args) && args.some((value) => String(value) === ${JSON.stringify(crawlerPath)})) {`,
    `    fs.appendFileSync(${JSON.stringify(crawlerAttemptFile)}, "crawler-spawn-attempted\\n", "utf8");`,
    '    const error = new Error("Crawler child must not start while the provider circuit is open");',
    '    error.code = "FIXTURE_CRAWLER_SPAWN_BLOCKED";',
    "    throw error;",
    "  }",
    "  return nativeSpawn.call(this, command, args, options);",
    "};"
  ].join("\n");
  await fsp.writeFile(preloadPath, `${source}\n`, "utf8");
  return preloadPath;
}

async function writeSingleFlightChildPreload(runtimeRoot, crawlerAttemptFile) {
  const preloadPath = path.join(runtimeRoot, "naver_single_flight_guard.cjs");
  const guardPath = path.join(ROOT, "scripts", "fixture_network_guard.cjs");
  const crawlerPath = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");
  const source = [
    '"use strict";',
    `require(${JSON.stringify(guardPath)}).installFixtureNetworkGuard({ allowLocalhost: true, label: "NAVER single-flight child" });`,
    'const fs = require("node:fs");',
    'const EventEmitter = require("node:events");',
    'const childProcess = require("node:child_process");',
    'const nativeSpawn = childProcess.spawn;',
    'childProcess.spawn = function guardedSpawn(command, args, options) {',
    `  if (Array.isArray(args) && args.some((value) => String(value) === ${JSON.stringify(crawlerPath)})) {`,
    `    fs.appendFileSync(${JSON.stringify(crawlerAttemptFile)}, "crawler-spawn-attempted\\n", "utf8");`,
    '    const child = new EventEmitter();',
    '    child.stdout = new EventEmitter();',
    '    child.stderr = new EventEmitter();',
    '    child.pid = 424242;',
    '    child.killed = false;',
    '    child.kill = () => { child.killed = true; };',
    '    setTimeout(() => {',
    '      child.stdout.emit("data", Buffer.from("{}\\n", "utf8"));',
    '      child.emit("close", 0);',
    '    }, 350);',
    '    return child;',
    '  }',
    '  return nativeSpawn.call(this, command, args, options);',
    '};'
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
      B2B_SEARCH_REUSE_TTL_MINUTES: "0",
      GLAMPING_ADMIN_USER: ADMIN_USER,
      GLAMPING_ADMIN_PASSWORD: ADMIN_PASSWORD,
      GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: B2B_USER,
      GLAMPING_B2B_PASSWORD: B2B_PASSWORD
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-12000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-12000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, server) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      const output = server.output();
      throw new Error(`fixture server exited with ${server.child.exitCode}\n${output.stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`fixture server health timeout\n${server.output().stderr}`);
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
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${pathname}, received ${text.slice(0, 240)}`);
    }
  }
  return { response, body };
}

async function rawHttpRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(3000);
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("timeout", () => socket.destroy(new Error("raw HTTP fixture timed out")));
    socket.once("error", reject);
  });
}

async function login(baseUrl, username, password, userAgent) {
  const result = await jsonRequest(baseUrl, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ username, password })
  });
  assert.equal(result.response.status, 200, `login failed for ${username}`);
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/);
  return cookie;
}

function sessionHeaders(cookie, userAgent, extra = {}) {
  return { cookie, "user-agent": userAgent, ...extra };
}

function crawlPayload(keyword) {
  return {
    keyword,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    searchMode: "keyword",
    productMode: "all",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    detailRankRanges: "1-10",
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 10
  };
}

async function postCrawl(baseUrl, pathname, cookie, userAgent, keyword) {
  return jsonRequest(baseUrl, pathname, {
    method: "POST",
    headers: sessionHeaders(cookie, userAgent, { "content-type": "application/json" }),
    body: JSON.stringify(crawlPayload(keyword))
  });
}

function assertCooldownResponse(result, label) {
  assert.equal(result.response.status, 503, `${label} must be rejected before provider transport`);
  assert.equal(result.body.code, "NAVER_PROVIDER_COOLDOWN_ACTIVE", `${label} returned the wrong stable error code`);
  assert.equal(result.body.retryable, true);
  assert.match(String(result.response.headers.get("retry-after") || ""), /^\d+$/);
  assert.ok(Number(result.response.headers.get("retry-after")) > 0);
  assert.ok(Number.isFinite(Date.parse(result.body.retryAt)), `${label} must expose a safe retryAt`);
  assert.ok(Number(result.body.retryAfterSeconds) > 0);
}

function assertNoPrivateProviderFields(value, location = "B2B response") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateProviderFields(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "diagnosticId") {
      assert.match(String(nested || ""), /^crawl-[a-f0-9]{12}$/, `${location}.${key} must remain an opaque public inquiry number`);
      continue;
    }
    assert.doesNotMatch(
      key,
      /subtype|lastDiagnostic|workflow|history|incident|rawBody|rawHtml|responseBody|requestUrl|responseUrl|queryString|headers|cookie|adminMemo/i,
      `${location}.${key} exposed provider-internal state`
    );
    assertNoPrivateProviderFields(nested, `${location}.${key}`);
  }
}

async function writeRun(runtimeRoot) {
  const runDir = path.join(runtimeRoot, "outputs", RUN_ID);
  await fsp.mkdir(runDir, { recursive: true });
  const manifest = {
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    collectorVersion: "naver-resilience-fixture-v1",
    keyword: "포천글램핑",
    searchKeyword: "포천글램핑",
    searchRegionKey: "kr_gyeonggi_pocheon",
    lodgingCategoryKey: "glamping",
    keywordType: "province",
    searchMode: "keyword",
    productMode: "all",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    collectionProfile: "revenue_detail_deep",
    detailRankRanges: "1-10",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 10,
    provinceKey: "gyeonggi",
    collectionStartedAt: "2026-07-01T00:00:00.000Z",
    collectionCompletedAt: "2026-07-01T00:01:00.000Z",
    dataAvailableAt: "2026-07-01T00:01:00.000Z",
    fileRoles: { report: "report.md", overall: "overall.csv" },
    files: ["report.md", "overall.csv"],
    counts: { naverOverall: 1, naverAds: 0, naverRegional: 1 }
  };
  await fsp.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(runDir, "report.md"), "# Pocheon last-known-good isolated fixture\n", "utf8");
  await fsp.writeFile(path.join(runDir, "overall.csv"), "rank,name\n1,fixture lodge\n", "utf8");
}

async function writeB2BHistory(runtimeRoot) {
  const historyFile = path.join(runtimeRoot, "customer_db", "b2b_search_history.json");
  await fsp.mkdir(path.dirname(historyFile), { recursive: true });
  const history = {
    schemaVersion: 1,
    updatedAt: "2026-07-01T00:02:00.000Z",
    entries: [{
      id: "naver-resilience-history-1",
      runId: RUN_ID,
      username: B2B_USER,
      status: "completed",
      keyword: "포천글램핑",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      searchMode: "keyword",
      productMode: "all",
      collectionMode: "precision",
      detailRankRanges: "1-10",
      bookingRangeDays: 7,
      bookingRangePlaceLimit: 10,
      quotaCounted: true,
      createdAt: "2026-07-01T00:01:30.000Z",
      completedAt: "2026-07-01T00:01:30.000Z"
    }]
  };
  await fsp.writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  return historyFile;
}

async function seedOpenProviderHealth(runtimeRoot) {
  const filePath = path.join(runtimeRoot, "provider_health", "naver_place_search.json");
  const health = createNaverProviderHealthStore({ filePath, runtimeRoot });
  const now = Date.now();
  const successAttemptAt = new Date(now - 10 * 60 * 1000).toISOString();
  const successAt = new Date(now - 9 * 60 * 1000).toISOString();
  const blockedAttemptAt = new Date(now).toISOString();
  const blockedAt = new Date(now + 1000).toISOString();

  const successAttempt = await health.beginAttempt({
    expectedWorkflowRevision: 0,
    explicit: true,
    now: successAttemptAt
  });
  const succeeded = await health.recordSuccess({
    expectedWorkflowRevision: successAttempt.state.workflowRevision,
    now: successAt
  });
  const blockedAttempt = await health.beginAttempt({
    expectedWorkflowRevision: succeeded.workflowRevision,
    explicit: true,
    now: blockedAttemptAt
  });
  const opened = await health.recordBlock({
    expectedWorkflowRevision: blockedAttempt.state.workflowRevision,
    now: blockedAt,
    failure: {
      subtype: "http_403",
      httpStatus: 403,
      diagnosticId: "crawl-c6ddda12830f"
    }
  });
  assert.equal(opened.state, "open");
  assert.ok(Date.parse(opened.retryAt) > Date.now());
  assert.equal(opened.lastSuccessAt, successAt);
  return { filePath, health, opened };
}

async function assertStaleAttemptLeaseRecovery(runtimeRoot) {
  const filePath = path.join(runtimeRoot, "lease_fixture", "naver_place_search.json");
  const store = createNaverProviderHealthStore({ filePath, runtimeRoot });
  const staleOffsetMs = (30 * 60 + PROVIDER_ATTEMPT_LEASE_SECONDS + 10 * 60) * 1000;
  const blockedAttemptAt = new Date(Date.now() - staleOffsetMs).toISOString();
  const blockedAt = new Date(Date.parse(blockedAttemptAt) + 1000).toISOString();
  const reserved = await store.beginAttempt({
    expectedWorkflowRevision: 0,
    explicit: true,
    now: blockedAttemptAt
  });
  const opened = await store.recordBlock({
    expectedWorkflowRevision: reserved.state.workflowRevision,
    now: blockedAt,
    failure: { subtype: "http_403", httpStatus: 403, diagnosticId: "crawl-c6ddda12830f" }
  });
  const interrupted = await store.beginAttempt({
    expectedWorkflowRevision: opened.workflowRevision,
    explicit: true,
    now: opened.retryAt
  });
  assert.equal(interrupted.allowed, true);
  assert.equal(interrupted.state.state, "probe_allowed");

  const reloaded = createNaverProviderHealthStore({ filePath, runtimeRoot });
  const staleState = await reloaded.read();
  const beforePassive = await fsp.readFile(filePath, "utf8");
  const passive = await reloaded.beginAttempt({
    expectedWorkflowRevision: staleState.workflowRevision,
    explicit: false,
    now: new Date()
  });
  assert.equal(passive.allowed, false, "a stale interrupted probe still requires an explicit user action");
  assert.equal(passive.reason, "explicit_probe_required");
  assert.equal(await fsp.readFile(filePath, "utf8"), beforePassive, "passive reads cannot recover or mutate a stale lease");

  const recovered = await reloaded.beginAttempt({
    expectedWorkflowRevision: staleState.workflowRevision,
    explicit: true,
    now: new Date()
  });
  assert.equal(recovered.allowed, true, "an explicit request can recover a stale in-flight reservation after restart");
  assert.equal(recovered.reason, "stale_attempt_recovered");
  assert.equal(recovered.attemptKind, "probe");
  assert.equal(recovered.state.workflowRevision, staleState.workflowRevision + 1);

  const recoveredText = await fsp.readFile(filePath, "utf8");
  const freshConcurrent = await reloaded.beginAttempt({
    expectedWorkflowRevision: recovered.state.workflowRevision,
    explicit: true,
    now: new Date(Date.now() + 1000)
  });
  assert.equal(freshConcurrent.allowed, false, "a fresh recovered probe remains single-flight");
  assert.equal(freshConcurrent.reason, "probe_in_flight");
  assert.equal(await fsp.readFile(filePath, "utf8"), recoveredText, "a rejected concurrent probe cannot mutate the lease");
}

async function assertAuthAndHealthBoundaries(baseUrl, adminCookie, b2bCookie, expectedState) {
  const anonymous = await jsonRequest(baseUrl, "/api/provider-health/naver-place-search", {
    headers: { "user-agent": ADMIN_AGENT }
  });
  assert.equal(anonymous.response.status, 401, "anonymous callers cannot inspect admin provider health");

  const forbidden = await jsonRequest(baseUrl, "/api/provider-health/naver-place-search", {
    headers: sessionHeaders(b2bCookie, B2B_AGENT)
  });
  assert.equal(forbidden.response.status, 403, "B2B callers cannot inspect admin provider health");

  const admin = await jsonRequest(baseUrl, "/api/provider-health/naver-place-search", {
    headers: sessionHeaders(adminCookie, ADMIN_AGENT)
  });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.body.providerId, "naver_place_search");
  assert.equal(admin.body.state, "open");
  assert.equal(admin.body.workflowRevision, expectedState.workflowRevision);
  assert.equal(admin.body.safeFailureSubtype, "http_403");
  assert.equal(admin.body.lastDiagnosticId, "crawl-c6ddda12830f");
  assert.equal(admin.body.retryAt, expectedState.retryAt);
  assert.equal(admin.body.fallbackAvailable, false, "provider health alone has no search contract for an exact fallback decision");

  const member = await jsonRequest(baseUrl, "/api/member/provider-health/naver-place-search", {
    headers: sessionHeaders(b2bCookie, B2B_AGENT)
  });
  assert.equal(member.response.status, 200);
  assert.equal(member.body.available, false);
  assert.equal(member.body.coolingDown, true);
  assert.equal(member.body.retryAt, expectedState.retryAt);
  assert.equal(member.body.fallbackAvailable, false, "the member health projection cannot claim a fallback without a search contract");
  assert.equal(Object.hasOwn(member.body, "diagnosticId"), false, "provider health does not expose an incident inquiry number to B2B");
  assertNoPrivateProviderFields(member.body, "B2B provider health");
}

async function assertCooldownAndFallbackBoundaries(baseUrl, adminCookie, b2bCookie, healthFile, healthState, historyFile) {
  const healthBefore = await fsp.readFile(healthFile, "utf8");
  const historyBeforeText = await fsp.readFile(historyFile, "utf8");
  const historyBefore = await jsonRequest(baseUrl, "/api/member/search-history", {
    headers: sessionHeaders(b2bCookie, B2B_AGENT)
  });
  assert.equal(historyBefore.response.status, 200);

  const exact = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑");
  assertCooldownResponse(exact, "exact admin request");
  assert.equal(exact.body.fallbackAvailable, true);
  assert.equal(exact.body.fallbackRunId, RUN_ID);
  assert.equal(exact.body.fallbackReason, "last_known_good_exact_contract");
  assert.equal(exact.body.fallbackFreshness.status, "stale");
  assert.equal(exact.body.fallbackSnapshot.status, "ready", "snapshot observation status remains separate from stale fallback freshness");
  assert.notEqual(exact.body.currentCollectionFailure?.status, "ready", "a blocked attempt cannot masquerade as current success");

  const mismatch = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "산청글램핑");
  assertCooldownResponse(mismatch, "mismatched admin request");
  assert.equal(mismatch.body.fallbackAvailable, false, "a different canonical region cannot reuse the Pocheon snapshot");
  assert.equal(mismatch.body.fallbackRunId ?? null, null);

  for (let index = 0; index < 2; index += 1) {
    const repeated = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑");
    assertCooldownResponse(repeated, `repeated admin request ${index + 1}`);
  }

  const concurrent = await Promise.all([
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑"),
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "산청글램핑"),
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "하동글램핑")
  ]);
  concurrent.forEach((result, index) => assertCooldownResponse(result, `concurrent admin request ${index + 1}`));

  const b2b = await postCrawl(baseUrl, "/api/b2b-search", b2bCookie, B2B_AGENT, "포천글램핑");
  assertCooldownResponse(b2b, "exact B2B request");
  assert.equal(b2b.body.fallbackAvailable, true);
  assert.equal(b2b.body.fallbackRunId, RUN_ID);
  assert.equal(b2b.body.fallbackReason, "last_known_good_exact_contract");
  assert.equal(b2b.body.fallbackFreshness.status, "stale");
  assertNoPrivateProviderFields(b2b.body, "B2B cooldown fallback");

  const historyAfter = await jsonRequest(baseUrl, "/api/member/search-history", {
    headers: sessionHeaders(b2bCookie, B2B_AGENT)
  });
  assert.equal(historyAfter.response.status, 200);
  const stableHistoryProjection = (value = {}) => ({
    ...value,
    quota: value.quota && typeof value.quota === "object"
      ? Object.fromEntries(Object.entries(value.quota).filter(([key]) => key !== "resetAfterSeconds"))
      : value.quota
  });
  assert.deepEqual(
    stableHistoryProjection(historyAfter.body),
    stableHistoryProjection(historyBefore.body),
    "cooldown rejection cannot consume daily quota or add history"
  );
  assert.equal(await fsp.readFile(historyFile, "utf8"), historyBeforeText, "cooldown rejection cannot mutate stored member history");
  assert.equal(await fsp.readFile(healthFile, "utf8"), healthBefore, "cooldown reads and rejections cannot rewrite health state");

  const reloaded = createNaverProviderHealthStore({ filePath: healthFile, runtimeRoot: path.dirname(path.dirname(healthFile)) });
  assert.deepEqual(await reloaded.read(), healthState, "all rejected requests leave workflowRevision and provider health content unchanged");
}

async function assertCorruptFallbackArtifactsFailClosed(baseUrl, adminCookie, runtimeRoot) {
  const runDir = path.join(runtimeRoot, "outputs", RUN_ID);
  const manifestPath = path.join(runDir, "manifest.json");
  const overallPath = path.join(runDir, "overall.csv");
  const missingPath = path.join(runDir, "overall.csv.fixture-missing");
  const originalManifestText = await fsp.readFile(manifestPath, "utf8");
  const originalManifest = JSON.parse(originalManifestText);

  await fsp.rename(overallPath, missingPath);
  try {
    const missingCore = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑");
    assertCooldownResponse(missingCore, "missing fallback core file");
    assert.equal(missingCore.body.fallbackAvailable, false, "a missing declared core file fails closed");
  } finally {
    await fsp.rename(missingPath, overallPath);
  }

  try {
    await fsp.writeFile(manifestPath, `${JSON.stringify({
      ...originalManifest,
      searchKeyword: "하동글램핑"
    }, null, 2)}\n`, "utf8");
    const conflictingKeyword = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑");
    assertCooldownResponse(conflictingKeyword, "conflicting fallback keyword aliases");
    assert.equal(conflictingKeyword.body.fallbackAvailable, false, "conflicting stored keyword aliases fail closed");

    await fsp.writeFile(manifestPath, `${JSON.stringify({
      ...originalManifest,
      searchRegionKey: "kr_gyeongnam_hadong"
    }, null, 2)}\n`, "utf8");
    const conflictingRegion = await postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑");
    assertCooldownResponse(conflictingRegion, "conflicting fallback region aliases");
    assert.equal(conflictingRegion.body.fallbackAvailable, false, "conflicting stored region aliases fail closed");
  } finally {
    await fsp.writeFile(manifestPath, originalManifestText, "utf8");
  }
}

async function assertClosedCircuitSingleFlight(baseUrl, adminCookie, crawlerAttemptFile) {
  const results = await Promise.all([
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "포천글램핑"),
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "산청글램핑"),
    postCrawl(baseUrl, "/api/crawl", adminCookie, ADMIN_AGENT, "하동글램핑")
  ]);
  assert.equal(results.filter((result) => result.response.status === 200).length, 1, "one explicit request owns the provider attempt");
  const suppressed = results.filter((result) => result.response.status !== 200);
  assert.equal(suppressed.length, 2);
  suppressed.forEach((result) => {
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "NAVER_PROVIDER_COOLDOWN_ACTIVE");
  });
  const attempts = (await fsp.readFile(crawlerAttemptFile, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(attempts.length, 1, "A→B→C concurrent contracts start exactly one crawler transport");
  const health = await jsonRequest(baseUrl, "/api/provider-health/naver-place-search", {
    headers: sessionHeaders(adminCookie, ADMIN_AGENT)
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.state, "closed", "the fake successful owner closes the circuit");
}

async function main() {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-provider-resilience-e2e-"));
  assert.equal(safeTempRoot(runtimeRoot), true, "fixture runtime must stay under the system temp directory");
  const crawlerAttemptFile = path.join(runtimeRoot, "crawler_spawn_attempted.txt");
  let server = null;
  try {
    const singleFlightRuntimeRoot = path.join(runtimeRoot, "single-flight-runtime");
    const singleFlightAttemptFile = path.join(runtimeRoot, "single_flight_crawler_attempts.txt");
    await fsp.mkdir(singleFlightRuntimeRoot, { recursive: true });
    const singleFlightPreload = await writeSingleFlightChildPreload(runtimeRoot, singleFlightAttemptFile);
    const singleFlightPort = await availablePort();
    const singleFlightBaseUrl = `http://127.0.0.1:${singleFlightPort}`;
    server = spawnServer(singleFlightPort, singleFlightRuntimeRoot, singleFlightPreload);
    await waitForHealth(singleFlightBaseUrl, server);
    const singleFlightAdminCookie = await login(singleFlightBaseUrl, ADMIN_USER, ADMIN_PASSWORD, ADMIN_AGENT);
    await assertClosedCircuitSingleFlight(singleFlightBaseUrl, singleFlightAdminCookie, singleFlightAttemptFile);
    await stopServer(server);
    server = null;

    await writeRun(runtimeRoot);
    const historyFile = await writeB2BHistory(runtimeRoot);
    const seeded = await seedOpenProviderHealth(runtimeRoot);
    await assertStaleAttemptLeaseRecovery(runtimeRoot);
    const persistedBeforeStart = await fsp.readFile(seeded.filePath, "utf8");
    const preloadPath = await writeChildPreload(runtimeRoot, crawlerAttemptFile);

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawnServer(port, runtimeRoot, preloadPath);
    await waitForHealth(baseUrl, server);

    const health = await jsonRequest(baseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body, { ok: true, loginRequired: true }, "/api/health must remain minimal");

    const invalidHostResponse = await rawHttpRequest(
      port,
      "GET /api/health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n"
    );
    assert.match(invalidHostResponse, /^HTTP\/1\.1 400\b/, "an invalid Host header must fail safely with HTTP 400");
    const healthAfterInvalidHost = await jsonRequest(baseUrl, "/api/health");
    assert.equal(healthAfterInvalidHost.response.status, 200, "a malformed Host request cannot terminate the server");

    const adminCookie = await login(baseUrl, ADMIN_USER, ADMIN_PASSWORD, ADMIN_AGENT);
    const b2bCookie = await login(baseUrl, B2B_USER, B2B_PASSWORD, B2B_AGENT);
    await assertAuthAndHealthBoundaries(baseUrl, adminCookie, b2bCookie, seeded.opened);
    await assertCooldownAndFallbackBoundaries(
      baseUrl,
      adminCookie,
      b2bCookie,
      seeded.filePath,
      seeded.opened,
      historyFile
    );
    await assertCorruptFallbackArtifactsFailClosed(baseUrl, adminCookie, runtimeRoot);

    assert.equal(server.child.exitCode, null, "the fixture server must remain alive after cooldown rejections");
    assert.equal(fs.existsSync(crawlerAttemptFile), false, "no crawler child or provider transport may be attempted while open");
    assert.doesNotMatch(server.output().stderr, /External network is forbidden|FIXTURE_CRAWLER_SPAWN_BLOCKED/);
    assert.equal(await fsp.readFile(seeded.filePath, "utf8"), persistedBeforeStart);

    await stopServer(server);
    server = null;

    const restartPort = await availablePort();
    const restartBaseUrl = `http://127.0.0.1:${restartPort}`;
    server = spawnServer(restartPort, runtimeRoot, preloadPath);
    await waitForHealth(restartBaseUrl, server);
    const restartedAdminCookie = await login(restartBaseUrl, ADMIN_USER, ADMIN_PASSWORD, ADMIN_AGENT);
    const restartedB2BCookie = await login(restartBaseUrl, B2B_USER, B2B_PASSWORD, B2B_AGENT);
    await assertAuthAndHealthBoundaries(restartBaseUrl, restartedAdminCookie, restartedB2BCookie, seeded.opened);
    assert.equal(await fsp.readFile(seeded.filePath, "utf8"), persistedBeforeStart, "restart reload must not mutate the open state");
    assert.equal(fs.existsSync(crawlerAttemptFile), false);
    assert.equal(server.child.exitCode, null);

    assert.equal(networkGuard.blockedAttempts(), 0, "the fixture itself made no non-local network request");
    console.log("NAVER provider resilience localhost E2E fixtures passed");
  } catch (error) {
    if (server) {
      const output = server.output();
      error.message = `${error.message}\nfixture stdout:\n${output.stdout}\nfixture stderr:\n${output.stderr}`;
    }
    throw error;
  } finally {
    await stopServer(server);
    networkGuard.restore();
    if (safeTempRoot(runtimeRoot)) await fsp.rm(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
