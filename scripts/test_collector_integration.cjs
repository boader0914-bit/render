"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { workerOptions, runWorker } = require("./collector_worker.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(__dirname, "glamping_app_server.cjs");
const TOKEN = "collector-integration-fixture-token-1234567890";
const WORKER = "collector-integration-worker";
const ADMIN = { username: "collector-test-admin", password: "temporary-collector-admin-fixture" };
const B2B = { username: "collector-test-b2b", password: "temporary-collector-b2b-fixture" };

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, route, cookie = "", options = {}) {
  const response = await fetch(`${base}${route}`, { ...options,
    headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  return { response, body: await response.json() };
}
const jsonPost = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function login(base, account) {
  const result = await request(base, "/api/login", "", jsonPost(account));
  assert.equal(result.response.status, 200);
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/);
  return cookie;
}
async function waitUntil(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(message);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function executionGuard(tempRoot) {
  const guardPath = path.join(tempRoot, "forbid-external-and-crawler.cjs");
  const attemptsPath = path.join(tempRoot, "forbidden-attempts.log");
  await fsp.writeFile(guardPath, `
const fs = require('node:fs');
function denied(operation) {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, operation + '\\n');
  throw new Error('Integration test forbids ' + operation);
}
const childProcess = require('node:child_process');
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[method] = () => denied('subprocess.' + method);
for (const protocol of ['node:http','node:https']) {
  const transport = require(protocol);
  transport.request = () => denied(protocol + '.request');
  transport.get = () => denied(protocol + '.get');
}
globalThis.fetch = () => denied('fetch');
`, "utf8");
  return { guardPath, attemptsPath };
}

async function writeMockArtifacts(env, keyword, index, partial) {
  const runId = `fixture_glamping_20260922_20000${index}`;
  const runDir = path.join(env.OUTPUTS_DIR, runId);
  const csv = "fixture_네이버전체순위.csv";
  const manifest = {
    outputDir: runDir, collectedAt: `2026-09-22T11:00:0${index}.000Z`, keyword,
    workerCollection: true, ...(env.SCHEDULED_COLLECTION === "1" ? { scheduledCollection: true } : {}),
    collectionProfile: "revenue_detail_deep",
    collectionProfileFlags: { collectBookingStock: true, collectWeeklyRange: true, collectRegional: true, collectOta: true },
    detailRankRanges: env.DETAIL_RANK_RANGES,
    naverAttemptedQueries: [{ status: 200 }],
    files: [csv], fileRoles: { overall: csv }, detailJsonFiles: [],
    counts: { naverOverall: 1, naverBookingStockEligible: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1,
      naverOtaObservationChecked: 1, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 2, naverScheduleSucceeded: partial ? 1 : 2, naverScheduleFailed: partial ? 1 : 0, naverScheduleBlocked: 0 },
    requestPacing: { enabled: true, minIntervalMs: 200, maxConcurrentRequests: 2, stopped: false },
  };
  const fields = { CHECK_IN: "checkIn", CHECK_OUT: "checkOut", ADULTS: "adults", SEARCH_MODE: "searchMode", SEARCH_INTENT: "searchIntent",
    SEARCH_REGION: "searchRegion", SEARCH_SCOPE: "searchScope", COLLECTION_MODE: "collectionMode", COLLECTION_PURPOSE: "collectionPurpose",
    PRODUCT_MODE: "productMode", BOOKING_RANGE_DAYS: "bookingRangeDays", BOOKING_RANGE_PLACE_LIMIT: "bookingRangePlaceLimit",
    SOURCE_ROLE: "sourceRole", COLLECTION_SOURCE: "collectionSource" };
  for (const [key, field] of Object.entries(fields)) if (env[key] !== undefined) manifest[field] = env[key];
  if (partial === "blocked") {
    manifest.collectionFailed = true;
    Object.assign(manifest.requestPacing, { blockedCode: "BookingAPITooManyRequests", blockedStatus: 200, stopped: true });
  }
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  await fsp.writeFile(path.join(runDir, csv), "place_id,업체명,전체순위,overall_rank,주소,네이버예약사업자ID,예약,네이버예약재고수집상태\n123456,통합시험숙소,1,1,경기도 가평군,987654,Y,성공\n");
  return { runId, runDir, csv };
}

function mockWorker(base, tempRoot, index, partial) {
  const spawned = [], requests = [], errors = [], events = [];
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_SERVER_URL: base, COLLECTOR_ALLOW_LOCAL_HTTP: "1",
    COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: WORKER, APP_PASSWORD: "fixture-never-forward" }, {
    workDir: path.join(tempRoot, "worker-jobs"), cwd: ROOT, maxJobs: 1, pollMs: 20,
    heartbeatMs: 100, requestTimeoutMs: 5000, heartbeatTimeoutMs: 1000, retryMs: 20,
    signal: AbortSignal.timeout(15000), logger: event => events.push(event),
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, base, "The worker may contact only the local fixture server");
      assert.ok(url.pathname.startsWith("/api/collector-worker/"));
      requests.push({ method: init.method, path: url.pathname });
      return fetch(input, init);
    },
    spawnImpl: (executable, args, config) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = (code, signal = null) => {
        if (closed) return;
        closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
      };
      child.kill = signal => { setImmediate(() => close(null, signal)); return true; };
      spawned.push({ executable, args, config });
      setImmediate(async () => {
        try {
          assert.equal(executable, process.execPath);
          assert.equal(path.basename(args[0]), "gyeongnam_glamping_crawl.cjs");
          assert.equal(config.env.COLLECTOR_WORKER_RUNTIME, "1");
          assert.equal(config.env.COLLECTOR_WORKER_TOKEN, undefined);
          assert.equal(config.env.APP_PASSWORD, undefined);
          assert.equal(config.shell, false);
          assert.equal(config.windowsHide, true);
          child.stdout.write("Checking Naver booking stock...\n");
          await writeMockArtifacts(config.env, args[1], index, partial);
          await delay(120);
          child.stdout.write("Writing outputs...\n");
          close(partial === "blocked" ? 1 : 0);
        } catch (error) { errors.push(error); close(1); }
      });
      return child;
    },
  });
  return { options, spawned, requests, errors, events };
}

async function main() {
  const tempBase = await fsp.realpath(os.tmpdir());
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "staydatalab-collector-integration-"));
  let server;
  try {
    const dataDir = path.join(tempRoot, "server-data");
    const outputsDir = path.join(dataDir, "outputs");
    const configDir = path.join(dataDir, "config");
    await fsp.mkdir(configDir, { recursive: true });
    const { guardPath, attemptsPath } = await executionGuard(tempRoot);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const logs = [];
    server = spawn(process.execPath, ["--require", guardPath, SERVER], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
      MASTER_DB_PATH: path.join(dataDir, "master_db", "test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
      COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: WORKER,
      GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
      GLAMPING_B2B_USER: B2B.username, GLAMPING_B2B_PASSWORD: B2B.password, GLAMPING_B2B_ENABLED: "1",
      RENDER_GIT_COMMIT: "collector-integration-fixture",
    } });
    server.stdout.on("data", chunk => logs.push(String(chunk)));
    server.stderr.on("data", chunk => logs.push(String(chunk)));
    await waitUntil(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited: ${logs.join("")}`);
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "Server readiness timed out", 15000);

    assert.equal((await request(base, "/api/collector-status")).response.status, 401);
    assert.equal((await request(base, "/api/crawl-status")).response.status, 401);
    const b2b = await login(base, B2B);
    assert.equal((await request(base, "/api/collector-status", b2b)).response.status, 403);
    assert.equal((await request(base, "/api/crawl", b2b, jsonPost({ keyword: "가평글램핑" }))).response.status, 403);
    const admin = await login(base, ADMIN);
    const status = await request(base, "/api/collector-status", admin);
    assert.equal(status.response.status, 200);
    assert.equal(status.body.executionMode, "worker");
    assert.equal(status.body.configured, true);
    assert.equal(JSON.stringify(status.body).includes(TOKEN), false);
    const claimRoute = "/api/collector-worker/claim";
    assert.equal((await request(base, claimRoute, admin, jsonPost({ workerId: WORKER, protocolVersion: 1 }))).response.status, 401);
    for (const [token, body, code] of [
      ["incorrect", { workerId: WORKER, protocolVersion: 1 }, 401],
      [TOKEN, { workerId: "wrong-worker", protocolVersion: 1 }, 403],
      [TOKEN, { workerId: WORKER, protocolVersion: 99 }, 400],
    ]) {
      const options = jsonPost(body); options.headers.Authorization = `Bearer ${token}`;
      assert.equal((await request(base, claimRoute, "", options)).response.status, code);
    }

    for (const [index, partial] of [[1, true], [2, false]]) {
      const payload = { keyword: index === 1 ? "가평글램핑" : "포천글램핑", checkIn: "2026-09-22", checkOut: "2026-09-23",
        collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", bookingRangeDays: 1, detailRankRanges: "1-20",
        clientRequestId: `collector-integration-${index}` };
      const pending = request(base, "/api/crawl", admin, jsonPost(payload));
      pending.catch(() => {}); // Keep cleanup from masking the first assertion failure.
      await waitUntil(async () => (await request(base, "/api/collector-status", admin)).body.queued === 1, "Admin crawl never queued");
      assert.equal(fs.existsSync(attemptsPath), false, "A queued worker job must not fall back to local collection");
      const active = await request(base, "/api/crawl-status", admin);
      assert.equal(active.body.active, true);
      const worker = mockWorker(base, tempRoot, index, partial);
      const [result, processed] = await Promise.all([pending, runWorker(worker.options)]);
      if (worker.errors.length) throw worker.errors[0];
      assert.equal(processed.jobs, 1);
      assert.equal(worker.spawned.length, 1);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.collectionQuality.status, partial ? "partial" : "complete");
      assert.ok(worker.requests.some(item => item.method === "PUT" && item.path.endsWith("/files")));
      assert.ok(worker.requests.some(item => item.path.endsWith("/complete")));
      assert.equal(worker.events.at(-1)?.event, "collector_job_completed");
      const runId = `fixture_glamping_20260922_20000${index}`;
      const canonical = path.join(outputsDir, runId);
      assert.equal(result.body.runId, runId);
      assert.equal(result.body.output.outputDir, canonical);
      const manifest = JSON.parse(await fsp.readFile(path.join(canonical, "manifest.json"), "utf8"));
      assert.equal(manifest.outputDir, canonical);
      assert.equal(manifest.workerCollection, true);
      assert.ok(result.body.runs.some(run => run.id === runId));
      const loaded = await request(base, `/api/runs/${runId}`, admin);
      assert.equal(loaded.response.status, 200, JSON.stringify(loaded.body));
      assert.equal(loaded.body.run.id, runId);
      assert.deepEqual(await fsp.readdir(worker.options.workDir), []);
      if (partial) {
        assert.equal(result.body.history, null);
        assert.equal(fs.existsSync(path.join(dataDir, "history", "observations.jsonl")), false);
        assert.equal(fs.existsSync(path.join(dataDir, "company_master", "companies.json")), false);
        assert.equal(fs.existsSync(path.join(dataDir, "master_db", "test.sqlite")), false);
      }
      assert.equal(fs.existsSync(attemptsPath), false, "No outbound request or real crawler launch is allowed");
    }

    const pending = request(base, "/api/crawl", admin, jsonPost({ keyword: "산청글램핑", checkIn: "2026-09-22", clientRequestId: "collector-no-worker" }));
    pending.catch(() => {});
    await waitUntil(async () => (await request(base, "/api/collector-status", admin)).body.queued === 1, "No-worker request never queued");
    await delay(100);
    assert.equal((await request(base, "/api/crawl-status", admin)).body.active, true);
    assert.equal(fs.existsSync(attemptsPath), false);
    const derivedFiles = [path.join(dataDir, "history", "observations.jsonl"), path.join(dataDir, "company_master", "companies.json")];
    const before = await Promise.all(derivedFiles.map(file => fsp.readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; })));
    const blockedWorker = mockWorker(base, tempRoot, 3, "blocked");
    const [blockedResult, blockedProcessed] = await Promise.all([pending, runWorker(blockedWorker.options)]);
    if (blockedWorker.errors.length) throw blockedWorker.errors[0];
    assert.equal(blockedProcessed.jobs, 1);
    assert.equal(blockedWorker.spawned.length, 1);
    assert.equal(blockedWorker.events.at(-1)?.event, "collector_failure_receipt_saved");
    assert.equal(blockedResult.response.status, 200, JSON.stringify(blockedResult.body));
    assert.equal(blockedResult.body.collectionQuality.status, "blocked");
    assert.equal(blockedResult.body.history, null);
    const blockedDir = path.join(outputsDir, "fixture_glamping_20260922_200003");
    const blockedManifest = JSON.parse(await fsp.readFile(path.join(blockedDir, "manifest.json"), "utf8"));
    assert.equal(blockedManifest.outputDir, blockedDir);
    assert.equal(blockedManifest.collectionFailed, true);
    assert.equal(blockedManifest.requestPacing.blockedCode, "BookingAPITooManyRequests");
    assert.equal((await request(base, "/api/runs/fixture_glamping_20260922_200003", admin)).response.status, 200);
    assert.deepEqual(await Promise.all(derivedFiles.map(file => fsp.readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; }))), before);
    await waitUntil(async () => !(await request(base, "/api/crawl-status", admin)).body.active, "Blocked job remained active");
    const finalStatus = await request(base, "/api/collector-status", admin);
    assert.equal(finalStatus.body.queued, 0);
    assert.equal(finalStatus.body.activeJobId, null);
    assert.equal(finalStatus.body.halted, true);
    assert.equal(finalStatus.body.errorCode, "COLLECTOR_PROVIDER_BLOCKED");
    const refused = await request(base, "/api/crawl", admin, jsonPost({ keyword: "태안글램핑", clientRequestId: "collector-after-block" }));
    assert.equal(refused.response.status, 503);
    const resetRoute = "/api/collector-reset-halt";
    const resetBody = { confirm: "resume-after-review" };
    assert.equal((await request(base, resetRoute, "", jsonPost(resetBody))).response.status, 401);
    assert.equal((await request(base, resetRoute, b2b, jsonPost(resetBody))).response.status, 403);
    assert.equal((await request(base, resetRoute, admin, jsonPost({}))).response.status, 400);
    const crossOrigin = jsonPost(resetBody);
    crossOrigin.headers.Origin = "https://unrelated.invalid";
    assert.equal((await request(base, resetRoute, admin, crossOrigin)).response.status, 403);
    assert.equal((await request(base, "/api/collector-status", admin)).body.halted, true);
    assert.equal((await request(base, resetRoute, admin, jsonPost(resetBody))).response.status, 200);
    const resetStatus = (await request(base, "/api/collector-status", admin)).body;
    assert.equal(resetStatus.halted, false);
    assert.equal(resetStatus.queued, 0);
    assert.equal(resetStatus.activeJobId, null);
    assert.equal((await fsp.readdir(outputsDir)).filter(name => name.startsWith("fixture_glamping_")).length, 3);
    assert.equal(fs.existsSync(attemptsPath), false);
    console.log("collector integration: authenticated admin -> real HTTP worker -> canonical artifacts, partial hold, failed-child block receipt, durable halt, machine auth and no-local-fallback passed; crawler mocked, external IO forbidden");
  } finally {
    await stopChild(server);
    const actual = await fsp.realpath(tempRoot);
    const relative = path.relative(tempBase, actual);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
    assert.equal(path.dirname(relative), ".");
    assert.ok(path.basename(relative).startsWith("staydatalab-collector-integration-"));
    await fsp.rm(actual, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
