"use strict";

// Real loopback HTTP and the real broker/worker; the crawler child is a fixture.
// Every file belongs to a fresh temporary directory. No provider or app server runs.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Readable, PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { createCollectorBroker } = require("./collector_broker.cjs");
const { workerOptions, runWorker } = require("./collector_worker.cjs");
const { writeMockArtifacts } = require("./test_collector_integration.cjs");

const TOKEN = "terminal-reconciliation-loopback-only-token-20261025";
const WORKER = "terminal-reconciliation-worker";
const BASE = "/api/collector-worker";
const identity = lease => ({ workerId: WORKER, leaseToken: lease.leaseToken });
const route = (lease, action) => `${BASE}/jobs/${lease.id}/${action}`;
const input = suffix => ({ keyword: `가상시험숙소${suffix}`, env: {
  CHECK_IN: "2026-10-25", CHECK_OUT: "2026-10-26", SEARCH_MODE: "keyword",
  COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail", DETAIL_RANK_RANGES: "1-20",
  BOOKING_RANGE_DAYS: "1", PRODUCT_MODE: "all", SCHEDULED_COLLECTION: "0",
}, payload: { keyword: `가상시험숙소${suffix}`, workerKey: "manual", trigger: "manual", scheduledCollection: false },
context: { historicalBookingBusinesses: [{ placeId: "123456", businessId: "987654" }] } });

function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
async function requestBytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fixture(t, settings = {}) {
  const tempBase = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempBase, "collector-terminal-http-"));
  const dataDir = path.join(directory, "data"), outputsDir = path.join(dataDir, "outputs");
  const ledgerFile = path.join(dataDir, "collector", "jobs.json");
  const sentinels = new Map();
  for (const [relative, value] of [
    ["config/schedule.json", '{"enabled":false,"hours":[9,21]}\n'],
    ["originals/raw-observation.json", '{"fixture":true,"stock":null}\n'],
    ["history/reservation-history.json", '{"fixture":true,"manualFields":["preserve"]}\n'],
    ["config/provider-protection.json", '{"halted":true,"reason":"fixture-preserve"}\n'],
  ]) {
    const file = path.join(dataDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, { flag: "wx" });
    sentinels.set(file, Buffer.from(value));
  }
  const state = { requests: [], spawned: [], kills: [], errors: [], events: [], lease: null, completeBodies: [] };
  const clock = { value: Date.now() };
  const broker = createCollectorBroker({ dataDir, outputsDir, token: TOKEN, workerId: WORKER, workerKey: "manual",
    ...(settings.mutableClock ? { now: () => clock.value } : {}) });
  await broker.initialize();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture.invalid"), raw = await requestBytes(req);
      let json;
      if (req.method === "POST") { try { json = JSON.parse(raw.toString("utf8")); } catch {} }
      state.requests.push({ method: req.method, path: url.pathname });
      const context = { req, res, url, raw, json, state, broker };
      if (settings.beforeDispatch && await settings.beforeDispatch(context)) return;
      const replay = Readable.from([raw]);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers });
      let status, headers, body;
      const capture = { headersSent: false,
        writeHead(code, values) { this.headersSent = true; status = code; headers = values; },
        end(value) { body = String(value); } };
      const handled = await broker.handleHttp(replay, capture, url);
      if (!handled) { send(res, 404, { error: "fixture_route_not_found" }); return; }
      const result = JSON.parse(body);
      if (url.pathname.endsWith("/claim") && result.job) state.lease = result.job;
      if (url.pathname.endsWith("/complete")) state.completeBodies.push(json);
      if (settings.afterDispatch && await settings.afterDispatch({ ...context, status, result })) return;
      res.writeHead(status, headers); res.end(body);
    } catch (error) {
      state.errors.push(error);
      if (!res.headersSent && !res.destroyed) send(res, 500, { error: "fixture_internal_error" });
      else res.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController(), watchdog = setTimeout(() => abort.abort(), 10000);
  const spawnImpl = (executable, args, config) => {
    assert.equal(executable, process.execPath);
    assert.equal(path.basename(args[0]), "gyeongnam_glamping_crawl.cjs");
    assert.equal(config.shell, false); assert.equal(config.windowsHide, true);
    assert.equal(config.env.COLLECTOR_WORKER_TOKEN, undefined);
    assert.equal(config.env.APP_PASSWORD, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    child.finish = (code = 0, signal = null) => {
      if (closed) return;
      closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
    };
    child.kill = signal => { state.kills.push(signal); setImmediate(() => child.finish(null, signal)); return true; };
    state.spawned.push({ child, config });
    setImmediate(async () => {
      try {
        if (settings.crawl) await settings.crawl({ child, config, state });
        else {
          await writeMockArtifacts(config.env, args[1], 1, false);
          child.stdout.write("Checking Naver booking stock...\n");
          await delay(150);
          child.finish();
        }
      } catch (error) { state.errors.push(error); child.finish(1); }
    });
    return child;
  };
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_SERVER_URL: base,
    COLLECTOR_ALLOW_LOCAL_HTTP: "1", COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: WORKER,
    COLLECTOR_WORKER_KEY: "manual", APP_PASSWORD: "fixture-secret-not-for-child" }, {
    cwd: path.resolve(__dirname, ".."), workDir: path.join(directory, "worker-jobs"), spawnImpl,
    maxJobs: 1, pollMs: 5, heartbeatMs: 30, heartbeatTimeoutMs: 200, requestTimeoutMs: 600,
    heartbeatAttempts: 3, terminalStatusAttempts: 3, uploadAttempts: 3, retryMs: 5, killTimeoutMs: 20,
    minFreeBytes: 1, maxTotalBytes: 1024 * 1024, signal: abort.signal, logger: event => state.events.push(event),
    fetchImpl: (url, init) => {
      assert.equal(new URL(String(url)).origin, base, "No external provider request is allowed");
      assert.ok(new URL(String(url)).pathname.startsWith(BASE + "/"));
      return fetch(url, init);
    },
  });
  async function post(endpoint, body, { token = TOKEN, method = "POST", raw } = {}) {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${token}`,
      "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body) }),
    signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  }
  const count = action => state.requests.filter(row => row.path.endsWith("/" + action)).length;
  const ledger = async () => JSON.parse(await fs.readFile(ledgerFile, "utf8"));
  const snapshot = async () => {
    const stat = await fs.stat(ledgerFile);
    return { raw: await fs.readFile(ledgerFile, "utf8"), mtimeMs: stat.mtimeMs, size: stat.size };
  };
  t.after(async () => {
    clearTimeout(watchdog); abort.abort();
    for (const { child } of state.spawned) child.finish();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try {
      for (const [file, bytes] of sentinels) assert.deepEqual(await fs.readFile(file), bytes, `Preserved fixture changed: ${file}`);
      if (state.errors.length) throw state.errors[0];
    } finally {
      const actual = await fs.realpath(directory);
      assert.equal(path.dirname(actual), tempBase);
      assert.ok(path.basename(actual).startsWith("collector-terminal-http-"));
      await fs.rm(actual, { recursive: true, force: true });
    }
  });
  return { directory, dataDir, outputsDir, ledgerFile, state, broker, options, post, count, ledger, snapshot,
    advance: ms => { clock.value += ms; } };
}
async function submitPair(f) {
  const first = await f.broker.submit(input("첫번째"));
  const queued = await f.broker.submit(input("다음작업"));
  return { first, queued };
}
function assertOnlyOneClaimAndChild(f, ledger, pair) {
  assert.equal(f.count("claim"), 1);
  assert.equal(f.state.spawned.length, 1);
  assert.ok(f.count("terminal-status") <= 3, "Terminal reconciliation must stay within its per-job request budget");
  assert.equal(ledger.jobs.find(job => job.id === pair.queued.id).status, "queued");
  assert.equal(JSON.stringify(f.state.events).includes(TOKEN), false);
}

test("transient heartbeat 502 recovers over HTTP without killing or rerunning the child", { timeout: 15000 }, async t => {
  let heartbeats = 0, injected = 0;
  const f = await fixture(t, { beforeDispatch({ url, res }) {
    if (url.pathname.endsWith("/heartbeat") && ++heartbeats === 2) {
      injected++; send(res, 502, { error: "fixture_temporary_gateway" }); return true;
    }
  } });
  const pair = await submitPair(f), result = await runWorker(f.options), ledger = await f.ledger();
  assert.equal(injected, 1); assert.ok(heartbeats >= 3);
  assert.equal(result.jobs, 1); assert.notEqual(result.halted, true);
  assertOnlyOneClaimAndChild(f, ledger, pair);
  assert.equal(ledger.jobs.find(job => job.id === pair.first.id).status, "completed");
  assert.equal(f.state.kills.length, 0); assert.equal(f.count("fail"), 0);
});

test("persisted failure reconciles after every failure ACK is lost and does not claim the next job", { timeout: 15000 }, async t => {
  const f = await fixture(t, { crawl: async ({ child }) => child.finish(1),
    afterDispatch({ url, status, req }) {
      if (url.pathname.endsWith("/fail") && status === 200) { req.socket.destroy(); return true; }
    } });
  const pair = await submitPair(f), result = await runWorker(f.options), ledger = await f.ledger();
  assert.equal(result.jobs, 1); assert.equal(result.halted, true);
  assert.ok(f.count("fail") >= 1 && f.count("fail") <= 3); assert.ok(f.count("terminal-status") >= 1);
  assertOnlyOneClaimAndChild(f, ledger, pair);
  const job = ledger.jobs.find(job => job.id === pair.first.id);
  assert.equal(job.status, "failed"); assert.ok(job.leaseReleasedAt); assert.ok(ledger.halted);
  const before = await f.snapshot();
  const proof = await f.post(route(f.state.lease, "terminal-status"), identity(f.state.lease));
  assert.equal(proof.body.terminal, true); assert.equal(proof.body.status, "failed");
  assert.equal(proof.body.errorCode, job.errorCode); assert.deepEqual(await f.snapshot(), before);
});

test("persisted completion reconciles when all completion ACKs are lost, without a fail overwrite", { timeout: 15000 }, async t => {
  const f = await fixture(t, { afterDispatch({ url, status, req }) {
    if (url.pathname.endsWith("/complete") && status === 200) { req.socket.destroy(); return true; }
  } });
  const pair = await submitPair(f), result = await runWorker(f.options), ledger = await f.ledger();
  assert.equal(result.jobs, 1); assert.notEqual(result.halted, true);
  assertOnlyOneClaimAndChild(f, ledger, pair);
  const job = ledger.jobs.find(job => job.id === pair.first.id);
  assert.equal(job.status, "completed"); assert.ok(job.leaseReleasedAt);
  assert.ok(f.count("complete") >= 1 && f.count("complete") <= 3); assert.ok(f.count("terminal-status") >= 1); assert.equal(f.count("fail"), 0);
  assert.equal((await fs.readdir(f.outputsDir)).filter(name => !name.startsWith(".")).length, 1);
  const before = await f.snapshot(), completion = f.state.completeBodies[0];
  const correct = await f.post(route(f.state.lease, "terminal-status"), { ...identity(f.state.lease), runId: completion.runId,
    files: [...completion.files].reverse() });
  assert.equal(correct.body.terminal, true); assert.equal(correct.body.completionMatches, true);
  const mismatch = await f.post(route(f.state.lease, "terminal-status"), { ...identity(f.state.lease),
    runId: completion.runId, files: completion.files.map(file => ({ ...file, sha256: "f".repeat(64) })) });
  assert.equal(mismatch.body.completionMatches, false);
  assert.deepEqual(await f.snapshot(), before);
});

test("a replayed already-failed claim is reconciled at initial heartbeat 409 before any child spawn", { timeout: 15000 }, async t => {
  let replay = null;
  const f = await fixture(t, { beforeDispatch({ url, res }) {
    if (replay && url.pathname.endsWith("/claim")) { send(res, 200, { job: replay }); return true; }
  } });
  const first = await f.broker.submit(input("既存失敗"));
  const lease = (await f.post(`${BASE}/claim`, { workerId: WORKER, protocolVersion: 1, workerKey: "manual" })).body.job;
  assert.equal((await f.post(route(lease, "fail"), { ...identity(lease), code: "COLLECTOR_CRAWL_FAILED" })).status, 200);
  const before = await f.snapshot(), requestOffset = f.state.requests.length;
  replay = lease;
  const result = await runWorker(f.options), workerRequests = f.state.requests.slice(requestOffset);
  assert.equal(result.jobs, 1); assert.equal(result.halted, true);
  assert.equal(f.state.spawned.length, 0);
  assert.equal(workerRequests.filter(row => row.path.endsWith("/claim")).length, 1);
  assert.ok(workerRequests.some(row => row.path.endsWith("/terminal-status")));
  assert.ok(workerRequests.filter(row => row.path.endsWith("/terminal-status")).length <= 3);
  assert.equal(workerRequests.filter(row => row.path.endsWith("/fail")).length, 0);
  assert.equal((await f.ledger()).jobs.find(job => job.id === first.id).status, "failed");
  assert.deepEqual(await f.snapshot(), before);
});

test("terminal-status HTTP rejects malformed or unauthenticated proof and never changes the durable ledger", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.broker.submit(input("照会"));
  const lease = (await f.post(`${BASE}/claim`, { workerId: WORKER, protocolVersion: 1 })).body.job;
  await f.post(route(lease, "fail"), { ...identity(lease), code: "COLLECTOR_CRAWL_FAILED" });
  const before = await f.snapshot();
  for (const [endpoint, body, options, expected] of [
    [route(lease, "terminal-status"), identity(lease), { token: "wrong-bearer" }, 401],
    [route(lease, "terminal-status"), { ...identity(lease), workerId: "other-worker" }, {}, 403],
    [route(lease, "terminal-status"), { ...identity(lease), leaseToken: "wrong-lease" }, {}, 409],
    [route(lease, "terminal-status"), { workerId: WORKER }, {}, 409],
    [route(lease, "terminal-status"), {}, { raw: "{not-json" }, 400],
    [route(lease, "terminal-status"), [], {}, 400],
    [route({ id: `collector_${crypto.randomUUID()}` }, "terminal-status"), identity(lease), {}, 404],
  ]) {
    const response = await f.post(endpoint, body, options);
    assert.equal(response.status, expected); assert.notEqual(response.body.terminal, true);
  }
  const proof = await f.post(route(lease, "terminal-status"), identity(lease));
  assert.equal(proof.body.terminal, true); assert.equal(proof.body.leaseReleased, true);
  const encoded = JSON.stringify(proof.body);
  for (const value of [TOKEN, lease.leaseToken, "leaseHash", "outputDir", "context", "keyword"]) assert.equal(encoded.includes(value), false);
  assert.deepEqual(await f.snapshot(), before);
});

test("terminal-status HTTP does not expire an overdue lease, halt protection or issue new work", { timeout: 15000 }, async t => {
  const f = await fixture(t, { mutableClock: true }), pair = await submitPair(f);
  const lease = (await f.post(`${BASE}/claim`, { workerId: WORKER, protocolVersion: 1 })).body.job;
  const before = await f.snapshot();
  f.advance(2 * lease.leaseMs);
  const proof = await f.post(route(lease, "terminal-status"), identity(lease));
  assert.equal(proof.status, 200); assert.equal(proof.body.status, "leased");
  assert.equal(proof.body.terminal, false); assert.equal(proof.body.leaseReleased, false);
  assert.deepEqual(await f.snapshot(), before);
  const ledger = await f.ledger();
  assert.equal(ledger.jobs.find(job => job.id === pair.first.id).status, "leased");
  assert.equal(ledger.jobs.find(job => job.id === pair.queued.id).status, "queued");
  assert.equal(ledger.halted, null); assert.equal(f.count("claim"), 1); assert.equal(f.state.spawned.length, 0);
});

for (const defect of ["malformed", "mismatched-completion"]) {
  test(`untrusted ${defect} terminal proof keeps completed bytes and halts without rerunning`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { afterDispatch({ url, status, req, res, result }) {
      if (url.pathname.endsWith("/complete") && status === 200) { req.socket.destroy(); return true; }
      if (url.pathname.endsWith("/terminal-status") && status === 200) {
        send(res, 200, defect === "malformed" ? { ok: true, terminal: true } : { ...result, completionMatches: false });
        return true;
      }
    } });
    const pair = await submitPair(f);
    await assert.rejects(runWorker(f.options), { code: "COLLECTOR_TERMINAL_ACK_REQUIRED" });
    const ledger = await f.ledger();
    assertOnlyOneClaimAndChild(f, ledger, pair);
    assert.equal(ledger.jobs.find(job => job.id === pair.first.id).status, "completed");
    assert.ok(f.count("terminal-status") >= 1);
    assert.equal((await fs.readdir(f.outputsDir)).filter(name => !name.startsWith(".")).length, 1);
  });
}
