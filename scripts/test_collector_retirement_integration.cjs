"use strict";

// Real loopback HTTP boundaries; provider network and crawler processes are forbidden.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { installFixture } = require("./test_operating_web_integration.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, writeMockArtifacts } = require("./test_collector_integration.cjs");
const { createCollectorRequests } = require("./collector_requests.cjs");
const { defaultConfig } = require("./keyword_worker_scheduler.cjs");
const { defaultConfig: dailyDefaultConfig } = require("./daily_keyword_collection_scheduler.cjs");

test("central HTTP retirement rejects new scheduled work, preserves receipts/results and leaves other workers independent", async () => {
  const root = path.resolve(__dirname, ".."), tempRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(tempRoot, "collector-retirement-http-"));
  let server;
  try {
    const dataDir = path.join(temporary, "data"), configDir = path.join(dataDir, "config"), outputsDir = path.join(dataDir, "outputs");
    const attempts = path.join(temporary, "forbidden.log"), events = path.join(temporary, "events.jsonl"), preload = path.join(temporary, "preload.cjs");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify({ root, attempts, events })});\n`);
    const configFile = path.join(configDir, "keyword-worker-schedule.json"), dailyFile = path.join(configDir, "daily_keyword_collection.json");
    const config = { ...defaultConfig(), enabled: true, keywords: ["경남글램핑"] };
    await fs.writeFile(configFile, JSON.stringify(config));
    await fs.writeFile(dailyFile, JSON.stringify({ ...dailyDefaultConfig(), enabled: true }));
    const beforeConfig = await fs.readFile(configFile), beforeDaily = await fs.readFile(dailyFile);
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const artifact = await writeMockArtifacts({ OUTPUTS_DIR: outputsDir, CHECK_IN: today, CHECK_OUT: today, DAY_USE_MODE: "inspect",
      COLLECTOR_WORKER_KEY: "scheduled", COLLECTOR_TRIGGER: "manual", COLLECTOR_RUN_TOKEN: "retirementfixture", DETAIL_RANK_RANGES: "1-5" }, "보존글램핑", 1, false);
    const previousBody = { clientRequestId: "retirement_old_request_0001", keyword: "보존글램핑", workerKey: "scheduled" };
    const previousPayload = { ...previousBody, dayUseMode: "inspect", trigger: "manual", scheduledCollection: false,
      allowRepeat: false, sourceRole: "admin", collectionSource: "admin_search" };
    const oldRequests = createCollectorRequests({ dataDir, run: async () => ({ runId: artifact.runId, workerKey: "scheduled", collectionQuality: { status: "complete" } }) });
    await oldRequests.submit(previousPayload);
    await waitUntil(async () => (await oldRequests.get(previousBody.clientRequestId)).status === "complete", "old fixture receipt completion");
    const receiptFile = path.join(dataDir, "history", "collector-requests", previousBody.clientRequestId + ".json");
    const beforeReceipt = await fs.readFile(receiptFile);
    const admin = { username: "retirement-http-admin", password: "retirement-http-fixture-password" };
    const token = "retirement-http-scheduled-token-123456789012345", workerId = "retirement-http-scheduled";
    const port = await freePort(), base = `http://127.0.0.1:${port}`, logs = [];
    server = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "",
        HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
        MASTER_DB_PATH: path.join(dataDir, "master_db/test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", COLLECTOR_EXECUTION_MODE: "worker",
        COLLECTOR_RETIRED_WORKER_KEYS: "scheduled", COLLECTOR_SCHEDULED_WORKER_ID: workerId, COLLECTOR_SCHEDULED_WORKER_TOKEN: token,
        COLLECTOR_WORKER_ID: "retirement-http-manual", COLLECTOR_WORKER_TOKEN: "retirement-http-manual-token-123456789012345",
        GLAMPING_ADMIN_USER: admin.username, GLAMPING_ADMIN_PASSWORD: admin.password, GLAMPING_B2B_ENABLED: "0" }
    });
    server.stdout.on("data", value => logs.push(String(value))); server.stderr.on("data", value => logs.push(String(value)));
    await waitUntil(async () => { if (server.exitCode !== null) throw new Error(logs.join("")); try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "fixture startup", 15000);
    const cookie = await login(base, admin);
    const read = route => request(base, route, cookie);
    const write = (route, body, method = "POST") => request(base, route, cookie, { ...jsonPost(body), method });
    const workers = (await read("/api/collector-status")).body.workers;
    const retired = workers.find(worker => worker.workerKey === "scheduled");
    assert.equal(retired.name, "AWS worker"); assert.equal(retired.retired, true); assert.equal(retired.ready, false);
    assert.match(retired.retirementReason, /인사이트/); assert.equal(retired.halted, false);
    for (const key of ["web", "manual"]) assert.equal(workers.find(worker => worker.workerKey === key).retired, false);
    assert.equal((await read("/api/crawl-status?workerKey=scheduled")).body.retired, true);
    const status = (await read("/api/worker-schedule?workerKey=scheduled")).body;
    assert.equal(status.enabled, false); assert.equal(status.config.enabled, true); assert.equal(status.storedEnabled, true); assert.equal(status.nextRunAt, null);
    const daily = (await read("/api/collection-schedule")).body;
    assert.equal(daily.retired, true); assert.equal(daily.enabled, false); assert.equal(daily.config.enabled, true); assert.equal(daily.nextRunAt, null);
    for (const [route, body, method] of [
      ["/api/crawl", { keyword: "새글램핑", workerKey: "scheduled" }],
      ["/api/crawl?async=1", { keyword: "새글램핑", workerKey: "scheduled", clientRequestId: "retirement_new_request_0001" }],
      ["/api/worker-schedule/enabled?workerKey=scheduled", { enabled: true }],
      ["/api/worker-schedule/run-now?workerKey=scheduled", { requestId: "retirement_new_schedule_0001" }],
      ["/api/worker-schedule?workerKey=scheduled", { keywords: ["가평글램핑"] }, "PUT"]
    ]) {
      const response = await write(route, body, method);
      assert.equal(response.response.status, 409, JSON.stringify({ route, body: response.body }));
      assert.equal(response.body.code, "COLLECTOR_WORKER_RETIRED", route);
    }
    // Same-request retry is an existing receipt lookup, even after the lane is retired.
    const oldRetry = await write("/api/crawl?async=1", previousBody);
    assert.equal(oldRetry.response.status, 202, JSON.stringify(oldRetry.body)); assert.equal(oldRetry.body.result.runId, artifact.runId);
    assert.equal((await read("/api/crawl-requests/" + previousBody.clientRequestId)).response.status, 200);
    assert.equal((await read("/api/runs/" + artifact.runId)).response.status, 200);
    const claimBody = { workerId, workerKey: "scheduled", protocolVersion: 1 };
    const claim = await request(base, "/api/collector-worker-scheduled/claim", "", { ...jsonPost(claimBody), headers: { "content-type": "application/json", authorization: "Bearer " + token } });
    assert.deepEqual(claim.body, { job: null, retired: true });
    const unauthenticated = await request(base, "/api/collector-worker-scheduled/claim", "", jsonPost(claimBody));
    assert.equal(unauthenticated.response.status, 401);
    const manualConfig = (await read("/api/worker-schedule?workerKey=manual")).body.config;
    const saved = await write("/api/worker-schedule?workerKey=manual", { ...manualConfig, keywords: ["다른글램핑"] }, "PUT");
    assert.equal(saved.response.status, 200); assert.equal(saved.body.enabled, false);
    assert.deepEqual(await fs.readFile(configFile), beforeConfig); assert.deepEqual(await fs.readFile(dailyFile), beforeDaily);
    assert.deepEqual(await fs.readFile(receiptFile), beforeReceipt);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "history", "collector-requests")), [previousBody.clientRequestId + ".json"]);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "history", "keyword-worker-schedule")), []);
    for (const file of [attempts, events]) {
      const contents = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      assert.equal(contents, "", "No crawler or provider request allowed");
    }
  } finally {
    await stopChild(server);
    assert.equal(path.dirname(path.resolve(temporary)), tempRoot);
    assert.ok(path.basename(temporary).startsWith("collector-retirement-http-"));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
