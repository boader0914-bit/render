"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { workerOptions, runWorker } = require("./collector_worker.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, executionGuard, writeMockArtifacts } = require("./test_collector_integration.cjs");

const ROOT = path.resolve(__dirname, "..");
const TOKENS = { manual: "roles-test-manual-only-token-123456789012345", scheduled: "roles-test-scheduled-only-token-1234567890" };
const IDS = { manual: "roles-test-manual", scheduled: "roles-test-scheduled" };
const ADMIN = { username: "roles-test-admin", password: "roles-test-admin-fixture-password" };
const B2B = { username: "roles-test-member", password: "roles-test-member-fixture-password" };
const day = value => new Date(value + 9 * 3600000).toISOString().slice(0, 10);

function makeWorker(base, temporary, workerKey, index, { beforeSave, blocked = false, neverFinish = false } = {}) {
  const spawned = [], errors = [], events = [], kills = [];
  const controller = new AbortController();
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_SERVER_URL: base, COLLECTOR_ALLOW_LOCAL_HTTP: "1",
    COLLECTOR_WORKER_KEY: workerKey, COLLECTOR_WORKER_ID: IDS[workerKey], COLLECTOR_WORKER_TOKEN: TOKENS[workerKey] }, {
    workDir: path.join(temporary, `jobs-${workerKey}-${index}`), cwd: ROOT, maxJobs: 1, pollMs: 10,
    heartbeatMs: 30, heartbeatTimeoutMs: 1000, requestTimeoutMs: 5000, retryMs: 10, signal: controller.signal,
    logger: event => events.push(event),
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, base, "Worker HTTP is limited to this local fixture");
      assert.ok(url.pathname.startsWith(workerKey === "manual" ? "/api/collector-worker/" : "/api/collector-worker-scheduled/"));
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
      child.kill = signal => { kills.push(signal); setImmediate(() => close(null, signal)); return true; };
      spawned.push({ config, args });
      setImmediate(async () => {
        try {
          assert.equal(executable, process.execPath);
          assert.equal(path.basename(args[0]), workerKey === "manual" ? "gyeongnam_glamping_crawl.cjs" : "archive_keyword_collector.cjs");
          assert.equal(config.env.COLLECTOR_WORKER_KEY, workerKey);
          assert.equal(config.env.COLLECTOR_WORKER_TOKEN, undefined);
          assert.equal(config.shell, false);
          await beforeSave?.();
          if (neverFinish || closed) return;
          if (blocked) child.stdout.write("COLLECTOR_PROVIDER_BLOCKED\n");
          await writeMockArtifacts(config.env, args[1], index, blocked ? "blocked" : false);
          close(blocked ? 1 : 0);
        } catch (error) { errors.push(error); close(1); }
      });
      return child;
    }
  });
  const started = runWorker(options);
  started.catch(() => {});
  return { spawned, errors, events, kills, started, stop: () => controller.abort() };
}

async function main() {
  const temporary = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "collector-roles-integration-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.mkdir(outputsDir);
  const { guardPath, attemptsPath } = await executionGuard(temporary);
  let server;
  const workers = [];
  try {
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const logs = [];
    server = spawn(process.execPath, ["--require", guardPath, path.join(__dirname, "glamping_app_server.cjs")], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
        MASTER_DB_PATH: path.join(dataDir, "master_db", "test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
        COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_ID: IDS.manual, COLLECTOR_WORKER_TOKEN: TOKENS.manual,
        COLLECTOR_SCHEDULED_WORKER_ID: IDS.scheduled, COLLECTOR_SCHEDULED_WORKER_TOKEN: TOKENS.scheduled,
        GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
        GLAMPING_B2B_USER: B2B.username, GLAMPING_B2B_PASSWORD: B2B.password, GLAMPING_B2B_ENABLED: "1"
      }
    });
    server.stdout.on("data", chunk => logs.push(String(chunk)));
    server.stderr.on("data", chunk => logs.push(String(chunk)));
    await waitUntil(async () => {
      if (server.exitCode !== null) throw new Error(logs.join(""));
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "Dual-worker fixture startup failed", 15000);
    const admin = await login(base, ADMIN), member = await login(base, B2B);
    const status = async () => (await request(base, "/api/collector-status", admin)).body;
    const queue = async (key, count) => (await status()).workers.find(worker => worker.workerKey === key).queued === count;
    const payload = (keyword, workerKey) => ({ keyword, workerKey, checkIn: day(Date.now()), checkOut: day(Date.now() + 86400000), adults: 2,
      searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", bookingRangeDays: 1,
      detailRankRanges: "1-5", bookingRangePlaceLimit: 5, clientRequestId: `roles-${workerKey}-${Math.random().toString(36).slice(2)}` });
    const submit = value => { const pending = request(base, "/api/crawl", admin, jsonPost(value)); pending.catch(() => {}); return pending; };
    const start = (key, index, options) => { const worker = makeWorker(base, temporary, key, index, options); workers.push(worker); return worker; };
    const finish = async (worker, pending) => {
      const [result] = await Promise.all([pending, worker.started]);
      assert.equal(worker.errors.length, 0, worker.errors[0]?.stack);
      assert.equal(worker.spawned.length, 1);
      return result;
    };

    // Machine credentials and role binding are separate from administrator login.
    for (const [target, token, id, key, expected] of [
      ["scheduled", TOKENS.manual, IDS.scheduled, "scheduled", 401],
      ["scheduled", TOKENS.scheduled, IDS.manual, "scheduled", 403],
      ["scheduled", TOKENS.scheduled, IDS.scheduled, "manual", 403],
      ["manual", TOKENS.scheduled, IDS.manual, "manual", 401]
    ]) {
      const options = jsonPost({ workerId: id, workerKey: key, protocolVersion: 1 });
      options.headers.Authorization = `Bearer ${token}`;
      assert.equal((await request(base, target === "manual" ? "/api/collector-worker/claim" : "/api/collector-worker-scheduled/claim", "", options)).response.status, expected);
    }
    assert.equal((await request(base, "/api/worker-schedule", member)).response.status, 403);
    // UI APIs are administrator-only and disconnected workers cannot accept
    // durable requests that would otherwise appear to run indefinitely.
    for (const [cookie, expected] of [["", 401], [member, 403]]) {
      assert.equal((await request(base, "/api/crawl-requests", cookie)).response.status, expected);
      assert.equal((await request(base, "/api/crawl-requests/roles-async-one", cookie)).response.status, expected);
      assert.equal((await request(base, "/api/crawl?async=1", cookie, jsonPost(payload("강원글램핑", "manual")))).response.status, expected);
    }
    for (const [route, method] of [["/api/crawl?async=1", "POST"], ["/api/worker-schedule", "PUT"], ["/api/worker-schedule/enabled", "POST"], ["/api/worker-schedule/run-now", "POST"]]) {
      const foreignOrigin = { ...jsonPost({}), method, headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } };
      assert.equal((await request(base, route, admin, foreignOrigin)).response.status, 403, `${method} ${route} must reject a foreign Origin`);
      const plainText = { ...jsonPost({}), method, headers: { "Content-Type": "text/plain", Origin: base } };
      assert.equal((await request(base, route, admin, plainText)).response.status, 415, `${method} ${route} must require JSON`);
    }
    const offline = await request(base, "/api/crawl?async=1", admin, jsonPost({ ...payload("강원글램핑", "manual"), clientRequestId: "roles-offline-request" }));
    assert.equal(offline.response.status, 409, JSON.stringify(offline.body));
    assert.match(offline.body.error, /최근 연결/);
    assert.deepEqual((await request(base, "/api/crawl-requests", admin)).body.requests, []);
    console.log("PASS dual-worker machine credentials and role isolation");

    // Different keywords execute concurrently in independent worker namespaces.
    const first = submit(payload("가평글램핑", "manual")), second = submit(payload("포천글램핑", "scheduled"));
    await waitUntil(async () => await queue("manual", 1) && await queue("scheduled", 1), "Independent jobs were not queued");
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const manual = start("manual", 1, { beforeSave: () => gate }), scheduled = start("scheduled", 2, { beforeSave: () => gate });
    await waitUntil(() => manual.spawned.length === 1 && scheduled.spawned.length === 1, "Independent workers did not both execute");
    const concurrent = await status();
    assert.ok(concurrent.workers.filter(worker=>worker.workerKey!=="web").every(worker => worker.activeJobId));
    assert.equal(concurrent.workers.find(worker=>worker.workerKey==="web").activeJobId,null);
    release();
    const [a, b] = await Promise.all([finish(manual, first), finish(scheduled, second)]);
    for (const result of [a, b]) { assert.equal(result.response.status, 200, JSON.stringify(result.body)); assert.equal(result.body.collectionQuality.status, "complete", JSON.stringify(result.body.collectionQuality)); }
    assert.notEqual(a.body.runId, b.body.runId);
    assert.equal(a.body.workerKey, "manual"); assert.equal(b.body.workerKey, "scheduled");
    assert.equal(scheduled.spawned[0].config.env.COLLECTOR_TRIGGER, "manual");
    console.log("PASS independent keywords execute on selected workers concurrently");

    // The same in-flight keyword is joined even when requested from the other worker.
    const sharedRequest = payload("경남글램핑", "manual");
    const shareA = submit(sharedRequest);
    await waitUntil(() => queue("manual", 1), "Shared source did not queue");
    const shareB = submit({ ...sharedRequest, workerKey: "scheduled", clientRequestId: "roles-share-second" });
    await delay(100);
    assert.equal(await queue("scheduled", 0), true);
    const sharedWorker = start("manual", 3);
    const sharedA = await finish(sharedWorker, shareA), sharedB = await shareB;
    assert.equal(sharedA.response.status, 200, JSON.stringify(sharedA.body));
    assert.equal(sharedB.response.status, 200, JSON.stringify(sharedB.body));
    assert.equal(sharedA.body.runId, sharedB.body.runId);
    assert.equal(sharedB.body.reuse.mode, "shared");
    const reused = await submit({ ...sharedRequest, workerKey: "scheduled", clientRequestId: "roles-reuse-next" });
    assert.equal(reused.response.status, 200, JSON.stringify(reused.body));
    assert.equal(reused.body.runId, sharedA.body.runId);
    assert.equal(reused.body.reuse.mode, "same_day");
    assert.ok((await status()).workers.every(worker => worker.queued === 0 && !worker.activeJobId));
    console.log("PASS cross-worker in-flight join and same-day successful reuse prevent recrawl");

    // Browser requests receive a durable receipt before a worker is available
    // to execute the job. An identical receipt ID cannot create a second job.
    const asyncPayload = { ...payload("강원글램핑", "manual"), clientRequestId: "roles-async-one" };
    const asyncAccepted = await request(base, "/api/crawl?async=1", admin, jsonPost(asyncPayload));
    assert.equal(asyncAccepted.response.status, 202, JSON.stringify(asyncAccepted.body));
    assert.equal(asyncAccepted.body.requestId, asyncPayload.clientRequestId);
    assert.equal(asyncAccepted.body.status, "pending");
    assert.equal(asyncAccepted.body.workerKey, "manual");
    assert.equal(asyncAccepted.body.result, null);
    const receiptFile = path.join(dataDir, "history", "collector-requests", `${asyncPayload.clientRequestId}.json`);
    assert.equal(JSON.parse(await fsp.readFile(receiptFile, "utf8")).status, "pending");
    const readPending = await request(base, `/api/crawl-requests/${asyncPayload.clientRequestId}`, admin);
    assert.equal(readPending.body.status, "pending");
    assert.equal(Object.hasOwn(readPending.body, "fingerprint"), false);
    const duplicateAccepted = await request(base, "/api/crawl?async=1", admin, jsonPost(asyncPayload));
    assert.equal(duplicateAccepted.response.status, 202);
    assert.equal(duplicateAccepted.body.requestId, asyncAccepted.body.requestId);
    await waitUntil(() => queue("manual", 1), "Accepted async job was not queued exactly once");
    assert.equal((await request(base, "/api/crawl-requests", admin)).body.requests.length, 1);
    const asyncWorker = start("manual", 7);
    await asyncWorker.started;
    assert.equal(asyncWorker.errors.length, 0, asyncWorker.errors[0]?.stack);
    assert.equal(asyncWorker.spawned.length, 1);
    let asyncFinal;
    await waitUntil(async () => {
      asyncFinal = (await request(base, `/api/crawl-requests/${asyncPayload.clientRequestId}`, admin)).body;
      return asyncFinal.status !== "pending";
    }, "Async result never reached a terminal receipt");
    assert.equal(asyncFinal.status, "complete", JSON.stringify(asyncFinal));
    assert.equal(asyncFinal.result.collectionQuality.status, "complete");
    assert.ok(asyncFinal.result.runId);
    assert.ok(asyncFinal.finishedAt);
    assert.equal((await request(base, `/api/runs/${asyncFinal.result.runId}`, admin)).response.status, 200);
    assert.equal(JSON.parse(await fsp.readFile(receiptFile, "utf8")).status, "complete");
    const duplicateComplete = await request(base, "/api/crawl?async=1", admin, jsonPost(asyncPayload));
    assert.equal(duplicateComplete.response.status, 202);
    assert.equal(duplicateComplete.body.result.runId, asyncFinal.result.runId);
    assert.equal(duplicateComplete.body.status, "complete");
    assert.equal(await queue("manual", 0), true);
    assert.equal(asyncWorker.spawned.length, 1);
    const conflict = await request(base, "/api/crawl?async=1", admin, jsonPost({ ...asyncPayload, keyword: "여수글램핑" }));
    assert.equal(conflict.response.status, 409);
    assert.equal((await request(base, `/api/crawl-requests/${asyncPayload.clientRequestId}`, admin)).body.result.runId, asyncFinal.result.runId);
    console.log("PASS async collection persists an immediate receipt, validates completion, and deduplicates repeated request IDs");

    // Saving settings cannot activate them; immediate collection preserves enabled state.
    const initialSchedule = await request(base, "/api/worker-schedule", admin);
    assert.equal(initialSchedule.body.enabled, false);
    const settings = { ...initialSchedule.body.config, keywords: ["대구글램핑"], firstDate: day(Date.now() + 86400000), time: "23:59",
      collection: { ...initialSchedule.body.config.collection, bookingDays: 1, detailRankRanges: "1-5" } };
    const invalidEnable = await request(base, "/api/worker-schedule", admin, { ...jsonPost({ ...settings, enabled: true }), method: "PUT" });
    assert.equal(invalidEnable.response.status, 400);
    const saved = await request(base, "/api/worker-schedule", admin, { ...jsonPost(settings), method: "PUT" });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.enabled, false);
    assert.equal((await request(base, "/api/worker-schedule/enabled", admin, jsonPost({ enabled: true }))).response.status, 200);
    const beforeNow = (await request(base, "/api/worker-schedule", admin)).body;
    assert.equal(beforeNow.enabled, true);
    const nowAccepted = await request(base, "/api/worker-schedule/run-now", admin, jsonPost({ requestId: "roles-run-now-one" }));
    assert.equal(nowAccepted.response.status, 202, JSON.stringify(nowAccepted.body));
    assert.match(nowAccepted.body.id, /^manual_[a-f0-9]{32,64}$/);
    assert.ok(["queued", "running"].includes(nowAccepted.body.status), JSON.stringify(nowAccepted.body));
    assert.equal(nowAccepted.body.trigger, "manual");
    await waitUntil(() => queue("scheduled", 1), "Saved immediate schedule did not target scheduled worker");
    const duplicatePending = await request(base, "/api/worker-schedule/run-now", admin, jsonPost({ requestId: "roles-run-now-one" }));
    assert.equal(duplicatePending.response.status, 202, JSON.stringify(duplicatePending.body));
    assert.equal(duplicatePending.body.id, nowAccepted.body.id);
    assert.equal(await queue("scheduled", 1), true);
    const nowWorker = start("scheduled", 4);
    await nowWorker.started;
    assert.equal(nowWorker.errors.length, 0, nowWorker.errors[0]?.stack);
    assert.equal(nowWorker.spawned.length, 1);
    let nowResult;
    await waitUntil(async () => {
      const current = (await request(base, "/api/worker-schedule", admin)).body;
      nowResult = current.today.find(entry => entry.id === nowAccepted.body.id);
      return nowResult && !["queued", "running"].includes(nowResult.status);
    }, "Accepted immediate collection never reached a terminal receipt");
    assert.equal(nowResult.status, "complete", JSON.stringify(nowResult));
    assert.equal(nowResult.trigger, "manual");
    const afterNow = (await request(base, "/api/worker-schedule", admin)).body;
    assert.equal(afterNow.enabled, true);
    assert.equal(afterNow.nextRunAt, beforeNow.nextRunAt);
    const duplicateNow = await request(base, "/api/worker-schedule/run-now", admin, jsonPost({ requestId: "roles-run-now-one" }));
    assert.equal(duplicateNow.response.status, 202, JSON.stringify(duplicateNow.body));
    assert.equal(duplicateNow.body.id, nowAccepted.body.id);
    assert.equal(duplicateNow.body.status, "complete");
    assert.equal(nowWorker.spawned.length, 1);
    assert.equal((await status()).workers.find(worker => worker.workerKey === "scheduled").queued, 0);
    assert.equal((await request(base, "/api/worker-schedule/enabled", admin, jsonPost({ enabled: false }))).response.status, 200);
    console.log("PASS save and activation are separate; immediate scheduled-worker collection preserves the saved schedule and deduplicates request IDs");

    // A real mocked stop-gate event cancels the other active lane and blocks new claims.
    const blocker = submit(payload("충남글램핑", "manual")), victim = submit(payload("충북글램핑", "scheduled"));
    await waitUntil(async () => await queue("manual", 1) && await queue("scheduled", 1), "Block scenario did not queue both lanes");
    const victimWorker = start("scheduled", 5, { neverFinish: true });
    await waitUntil(() => victimWorker.spawned.length === 1, "Other lane did not begin before block");
    const blockerWorker = start("manual", 6, { blocked: true });
    const blockedResult = await finish(blockerWorker, blocker), interrupted = await finish(victimWorker, victim);
    assert.equal(blockedResult.response.status, 200, JSON.stringify(blockedResult.body));
    assert.equal(blockedResult.body.collectionQuality.status, "blocked");
    assert.notEqual(interrupted.response.status, 200);
    assert.ok(victimWorker.kills.length >= 1);
    const protectedStatus = await status();
    assert.ok(protectedStatus.workers.every(worker => worker.halted && worker.errorCode === "COLLECTOR_PROVIDER_BLOCKED"));
    const refused = await submit(payload("전남글램핑", "scheduled"));
    assert.equal(refused.response.status, 409);
    assert.equal(fs.existsSync(attemptsPath), false, "Fixture forbids external HTTP and actual collector subprocesses");
    console.log("PASS provider gate event stops the other active worker, preserves failed evidence, and prevents another collection");
    console.log("collector roles integration: role isolation, readiness, concurrent collection, same-day reuse, async receipts, scheduling and provider protection passed with mock workers and no external collection");
  } finally {
    for (const worker of workers) worker.stop();
    await Promise.allSettled(workers.map(worker => worker.started));
    await stopChild(server);
    const resolved = await fsp.realpath(temporary);
    assert.equal(path.dirname(resolved), await fsp.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("collector-roles-integration-"));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
