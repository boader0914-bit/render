"use strict";

// Exercise real local HTTP boundaries. Both collection engines are fixtures;
// the server cannot create a real crawler or make any outbound provider call.
const assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises");
const path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { installFixture } = require("./test_operating_web_integration.cjs");
const { workerOptions, runWorker } = require("./collector_worker.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, writeMockArtifacts } = require("./test_collector_integration.cjs");

const ROOT = path.resolve(__dirname, "..");
const ADMIN = { username: "rotation-api-admin", password: "rotation-api-admin-fixture-password" };
const MEMBER = { username: "rotation-api-member", password: "rotation-api-member-fixture-password" };
const TOKEN = "rotation-api-manual-fixture-token-123456789012345";
const WORKER_ID = "rotation-api-manual-fixture";
const keywords = ["경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑", "충남글램핑", "전남글램핑", "전북글램핑", "대전글램핑", "서울근교글램핑", "경주글램핑", "여수글램핑", "가평글램핑", "포천글램핑"];
const day = offset => new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

function createFixtureWorker(base, temporary, eventsFile) {
  const controller = new AbortController(), spawned = [], errors = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const record = event => fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_ALLOW_LOCAL_HTTP: "1", COLLECTOR_SERVER_URL: base,
    COLLECTOR_WORKER_KEY: "manual", COLLECTOR_WORKER_ID: WORKER_ID, COLLECTOR_WORKER_TOKEN: TOKEN }, {
    workDir: path.join(temporary, "manual-jobs"), cwd: ROOT, maxJobs: 1, pollMs: 20, retryMs: 10,
    heartbeatMs: 30, heartbeatTimeoutMs: 1000, requestTimeoutMs: 5000, signal: controller.signal, logger: () => {},
    fetchImpl: (input, init) => { assert.equal(new URL(input).origin, base); return fetch(input, init); },
    spawnImpl: (executable, args, settings) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = (code, signal = null) => {
        if (closed) return; closed = true;
        record({ event: "close", workerKey: "manual", keyword: args[1], code, signal });
        child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
      };
      child.kill = signal => { setImmediate(() => close(null, signal)); return true; };
      spawned.push(settings.env); record({ event: "start", workerKey: "manual", keyword: args[1] });
      setImmediate(async () => {
        try {
          assert.equal(executable, process.execPath); assert.equal(settings.shell, false);
          assert.equal(settings.env.COLLECTOR_WORKER_TOKEN, undefined);
          child.stdout.write("Checking Naver booking stock...\n");
          await held; if (closed) return;
          await writeMockArtifacts(settings.env, args[1], 29, false); close(0);
        } catch (error) { errors.push(error); close(1); }
      });
      return child;
    }
  });
  const done = runWorker(options); done.catch(() => {});
  return { done, spawned, errors, release, stop: () => { release(); controller.abort(); } };
}

async function main() {
  const tempBase = await fsp.realpath(os.tmpdir());
  const temporary = await fsp.mkdtemp(path.join(tempBase, "collection-rotation-api-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
  await fsp.mkdir(configDir, { recursive: true }); await fsp.mkdir(outputsDir);
  const attempts = path.join(temporary, "forbidden.log"), events = path.join(temporary, "events.jsonl"), preload = path.join(temporary, "preload.cjs");
  await fsp.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify({ root: ROOT, attempts, events })});\n`);
  let server, fixtureWorker;
  const logs = [];
  try {
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--require", preload, path.join(ROOT, "scripts/glamping_app_server.cjs")], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
        MASTER_DB_PATH: path.join(dataDir, "master_db/test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_EXECUTION_MODE: "worker",
        COLLECTOR_WORKER_ID: WORKER_ID, COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_RETIRED_WORKER_KEYS: "scheduled",
        COLLECTOR_SCHEDULED_WORKER_TOKEN: "", GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
        GLAMPING_B2B_USER: MEMBER.username, GLAMPING_B2B_PASSWORD: MEMBER.password, GLAMPING_B2B_ENABLED: "1"
      }
    });
    server.stdout.on("data", chunk => logs.push(String(chunk))); server.stderr.on("data", chunk => logs.push(String(chunk)));
    await waitUntil(async () => {
      if (server.exitCode !== null) throw Error(logs.join(""));
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "Rotation fixture server startup", 15000);
    const admin = await login(base, ADMIN), member = await login(base, MEMBER);
    const api = (route, options) => request(base, route, admin, options);
    const rotation = () => api("/api/collection-rotation");
    const controllers = async () => (await api("/api/collector-status")).body;
    for (const [cookie, expected] of [["", 401], [member, 403]]) {
      for (const route of ["/api/collection-rotation", "/api/collection-rotation/history"]) {
        assert.equal((await request(base, route, cookie)).response.status, expected, route);
      }
      assert.equal((await request(base, "/api/collection-rotation/preview", cookie, jsonPost({}))).response.status, expected);
    }
    for (const [route, method] of [["/api/collection-rotation/preview", "POST"], ["/api/collection-rotation", "PUT"], ["/api/collection-rotation/enabled", "POST"]]) {
      assert.equal((await api(route, { ...jsonPost({}), method, headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } })).response.status, 403, route);
      assert.equal((await api(route, { ...jsonPost({}), method, headers: { "Content-Type": "text/plain", Origin: base } })).response.status, 415, route);
    }
    const initial = await rotation(); assert.equal(initial.response.status, 200); assert.equal(initial.body.enabled, false);
    const initialHistory = await api("/api/collection-rotation/history");
    assert.equal(initialHistory.response.status, 200); assert.deepEqual(initialHistory.body.items, []);
    const initialConfig = initial.body.config;
    assert.ok(initialConfig && typeof initialConfig === "object", "Status includes its editable configuration");
    const config = { ...initialConfig, enabled: false, firstDate: day(1), keywords,
      collection: { ...initialConfig.collection, bookingDays: 1, detailRankRanges: "1-5", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", dayUseMode: "inspect" } };
    const preview = await api("/api/collection-rotation/preview", jsonPost({ config, days: 7 }));
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.deepEqual((await rotation()).body.config, initialConfig, "Preview does not save or activate a plan");
    const saved = await api("/api/collection-rotation", { ...jsonPost(config), method: "PUT" });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.enabled, false);
    assert.deepEqual(saved.body.config.keywords, keywords);
    const runs = (await api("/api/runs")).body;
    assert.equal((Array.isArray(runs) ? runs : runs.runs).length, 0);
    assert.equal((await api("/api/crawl-requests")).body.requests.length, 0);
    assert.equal(fs.existsSync(events), false, "Preview/save/read cannot start either collection engine");
    assert.equal((await api("/api/collection-rotation/enabled", jsonPost({ enabled: "true" }))).response.status, 400);
    const offline = await api("/api/collection-rotation/enabled", jsonPost({ enabled: true }));
    assert.equal(offline.response.status, 409, "An offline selected worker cannot activate the shared schedule");
    assert.equal((await rotation()).body.enabled, false);
    console.log("PASS administrator-only JSON/origin checks, read-only preview, disabled save and offline activation");

    fixtureWorker = createFixtureWorker(base, temporary, events);
    await waitUntil(async () => Boolean((await controllers()).workers.find(worker => worker.workerKey === "manual").workerLastSeenAt), "Mock BG worker connection");
    const individual = (await api("/api/worker-schedule?workerKey=web")).body.config;
    const individualConfig = { ...individual, firstDate: day(1), time: "23:59", keywords: ["개별예약시험글램핑"] };
    assert.equal((await api("/api/worker-schedule?workerKey=web", { ...jsonPost(individualConfig), method: "PUT" })).response.status, 200);
    assert.equal((await api("/api/worker-schedule/enabled?workerKey=web", jsonPost({ enabled: true }))).response.status, 200);
    assert.equal((await api("/api/collection-rotation/enabled", jsonPost({ enabled: true }))).response.status, 409, "Individual schedule excludes shared activation");
    assert.equal((await api("/api/worker-schedule/enabled?workerKey=web", jsonPost({ enabled: false }))).response.status, 200);
    const enabled = await api("/api/collection-rotation/enabled", jsonPost({ enabled: true }));
    assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body)); assert.equal(enabled.body.enabled, true);
    assert.equal((await api("/api/worker-schedule/enabled?workerKey=web", jsonPost({ enabled: true }))).response.status, 409, "Shared schedule excludes individual activation");
    assert.equal((await api("/api/collection-rotation", { ...jsonPost(config), method: "PUT" })).response.status, 409, "Pause before editing an active shared schedule");
    assert.equal(fs.existsSync(events), false, "Tomorrow's schedule does not run immediately on activation");
    console.log("PASS shared/individual schedule mutual exclusion and explicit activation");

    const payload = (keyword, workerKey, clientRequestId) => ({ keyword, workerKey, clientRequestId, checkIn: day(0), checkOut: day(1), adults: 2,
      searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", dayUseMode: "inspect", bookingRangeDays: 1,
      detailRankRanges: "1-5", bookingRangePlaceLimit: 5 });
    const bgRequest = await api("/api/crawl?async=1", jsonPost(payload("직렬BG시험글램핑", "manual", "rotation-api-bg-manual")));
    assert.equal(bgRequest.response.status, 202, JSON.stringify(bgRequest.body));
    await waitUntil(() => fixtureWorker.spawned.length === 1, "BG manual job entered its mock engine");
    const webRequest = await api("/api/crawl?async=1", jsonPost(payload("순차웹시험글램핑", "web", "rotation-api-web-manual")));
    assert.equal(webRequest.response.status, 202, JSON.stringify(webRequest.body));
    await waitUntil(async () => (await api("/api/crawl-status?workerKey=web")).body.queueLength === 1, "Web job waits in its separate lane");
    await delay(150);
    let observed = (await fsp.readFile(events, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(observed.filter(event => event.event === "start" && event.workerKey === "web").length, 0, "Global execution gate prevents web/BG overlap");
    fixtureWorker.release();
    for (const requestId of ["rotation-api-bg-manual", "rotation-api-web-manual"]) {
      await waitUntil(async () => {
        const receipt = (await api(`/api/crawl-requests/${requestId}`)).body;
        if (receipt.status === "pending") return false;
        assert.equal(receipt.status, "complete", JSON.stringify({ receipt, logs: logs.slice(-12), workerErrors: fixtureWorker.errors.map(String) }));
        return true;
      }, `${requestId} completes without another request`, 20000);
    }
    await fixtureWorker.done; assert.deepEqual(fixtureWorker.errors, []);
    observed = (await fsp.readFile(events, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(observed.findIndex(event => event.event === "close" && event.workerKey === "manual") < observed.findIndex(event => event.event === "start" && event.workerKey === "web"), "Completion wakes the other worker lane only after the running engine closes");
    assert.equal((await rotation()).body.enabled, true, "Normal manual work does not disable the future rotation");
    const paused = await api("/api/collection-rotation/enabled", jsonPost({ enabled: false }));
    assert.equal(paused.response.status, 200); assert.equal(paused.body.enabled, false);
    assert.ok((await controllers()).workers.every(worker => !worker.halted), "Schedule changes do not alter worker protections");
    assert.equal(fs.existsSync(attempts), false, fs.existsSync(attempts) ? await fsp.readFile(attempts, "utf8") : "");
    console.log("PASS shared-active execution serializes manual engines and wakes the queued peer lane without provider IO");

    // A provider job submitted to the remote broker is not yet an actual crawl.
    // Pausing in this interval must cancel the unclaimed job rather than let a
    // later worker poll start collection after the administrator's pause.
    const queuedConfig = { ...config, firstDate: day(0), time: "00:00", keywordIntervalMinutes: 1,
      workers: [{ workerKey: "manual", dailyLimit: 1 }, { workerKey: "web", dailyLimit: 1 }] };
    const queueSave = await api("/api/collection-rotation", { ...jsonPost(queuedConfig), method: "PUT" });
    assert.equal(queueSave.response.status, 200, JSON.stringify(queueSave.body));
    const claim = async () => {
      const machine = jsonPost({ workerId: WORKER_ID, workerKey: "manual", protocolVersion: 1 });
      machine.headers.Authorization = `Bearer ${TOKEN}`;
      return request(base, "/api/collector-worker/claim", "", machine);
    };
    assert.equal((await claim()).body.job, null, "Only refresh the local mock connection, without a provider job");
    const queueEnabled = await api("/api/collection-rotation/enabled", jsonPost({ enabled: true }));
    assert.equal(queueEnabled.response.status, 200, JSON.stringify(queueEnabled.body));
    await waitUntil(async () => (await controllers()).workers.find(worker => worker.workerKey === "manual").queued === 1, "Rotation reaches an unclaimed mock BG dispatch", 20000);
    assert.equal((await api("/api/collection-rotation/enabled", jsonPost({ enabled: false }))).response.status, 200);
    await waitUntil(async () => {
      const worker = (await controllers()).workers.find(row => row.workerKey === "manual");
      return worker.queued === 0 && worker.activeJobId === null && worker.crawl.active === false;
    }, "Pause cancels the unclaimed remote job", 5000);
    assert.equal((await claim()).body.job, null, "A later worker poll cannot claim the paused rotation job");
    const afterQueuePause = (await rotation()).body;
    assert.equal(afterQueuePause.enabled, false);
    assert.equal(afterQueuePause.todayItems.length, 2);
    assert.ok(afterQueuePause.todayItems.every(item => item.status !== "running" && item.status !== "complete"));
    assert.ok(afterQueuePause.todayItems.every(item => item.status !== "uncertain"), "A broker-confirmed unclaimed cancellation is a known non-execution, rather than an ambiguous remote execution");
    assert.equal((await api("/api/collection-rotation/history")).body.items.length, 2);
    assert.equal(fs.existsSync(attempts), false);
    console.log("PASS pausing after dispatch prevents a still-unclaimed remote collection from starting");

    // Preserve older non-executed history beyond one scheduler API page. These
    // rows are test fixtures in the isolated temporary scheduling database.
    const store = new DatabaseSync(path.join(configDir, "collection-rotation.sqlite"));
    try {
      const oldConfig = JSON.stringify(afterQueuePause.config);
      const insertDay = store.prepare("INSERT INTO rotation_days VALUES(?,?,?,?,?,?)");
      const insertSlot = store.prepare("INSERT INTO rotation_slots(id,day,slot_index,worker_key,keyword,scheduled_at,status,error_code) VALUES(?,?,?,?,?,?,'missed','ROTATION_FIXTURE_MISSED')");
      store.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 1001; index += 1) {
        const date = new Date(Date.parse("2024-01-01T00:00:00Z") + Math.floor(index / 4) * 86400000).toISOString().slice(0, 10);
        const slotIndex = index % 4;
        if (slotIndex === 0) insertDay.run(date, afterQueuePause.revision, 0, 4, oldConfig, `${date}T00:00:00.000Z`);
        insertSlot.run(`rotation_${date}_${slotIndex + 1}`, date, slotIndex, slotIndex % 2 ? "manual" : "web", keywords[slotIndex], `${date}T00:00:00.000Z`);
      }
      store.exec("COMMIT");
    } finally { store.close(); }
    const firstPage = await api("/api/collection-rotation/history?from=2024-01-01&to=2024-12-31&limit=1000&offset=0");
    assert.equal(firstPage.response.status, 200); assert.equal(firstPage.body.items.length, 1000); assert.equal(firstPage.body.total, 1001); assert.equal(firstPage.body.hasMore, true);
    const lastPage = await api("/api/collection-rotation/history?from=2024-01-01&to=2024-12-31&limit=1000&offset=1000");
    assert.equal(lastPage.body.items.length, 1); assert.equal(lastPage.body.hasMore, false);
    assert.equal(new Set([...firstPage.body.items, ...lastPage.body.items].map(item => item.id)).size, 1001);
    const combinedHistory = await api("/api/collection-history?from=2024-01-01&to=2024-12-31&groupBy=year&groupKey=2024&limit=50");
    assert.equal(combinedHistory.response.status, 200, JSON.stringify(combinedHistory.body));
    assert.equal(combinedHistory.body.summary.total, 1001, "The combined history adapter reads every rotation page rather than silently dropping older failures");
    assert.equal(combinedHistory.body.sources.rotation.status, "available");
    assert.equal(combinedHistory.body.rows.length, 50); assert.equal(combinedHistory.body.totalRows, 1001);
    assert.equal(fs.existsSync(attempts), false);
    console.log("PASS rotation API paging and combined history retain more than 1000 old missed allocations");
  } finally {
    fixtureWorker?.stop(); if (fixtureWorker) await Promise.allSettled([fixtureWorker.done]); await stopChild(server);
    const actual = await fsp.realpath(temporary), relative = path.relative(tempBase, actual);
    assert.equal(path.isAbsolute(relative), false); assert.equal(relative.startsWith(".."), false); assert.equal(path.dirname(relative), ".");
    assert.ok(path.basename(relative).startsWith("collection-rotation-api-")); await fsp.rm(actual, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
