"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { freePort, request, jsonPost, login, waitUntil, stopChild } = require("./test_collector_integration.cjs");

const ROOT = path.resolve(__dirname, "..");
const ADMIN = { username: "web-integration-admin", password: "web-integration-admin-fixture" };
const MEMBER = { username: "web-integration-member", password: "web-integration-member-fixture" };
const TOKENS = { manual: "web-integration-manual-token-1234567890", scheduled: "web-integration-scheduled-token-1234567890" };
const IDS = { manual: "web-integration-manual", scheduled: "web-integration-scheduled" };
const day = offset => new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

// Runs only inside the fixture server. The real HTTP/API boundary is retained,
// but every crawler child and outbound network operation is explicitly forbidden.
function installFixture(config) {
  const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path");
  const assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
  const { setTimeout: delay } = require("node:timers/promises");
  function deny(operation) {
    fs.appendFileSync(config.attempts, `${operation}\n`);
    throw new Error(`Operating-web integration forbids ${operation}`);
  }
  const childProcess = require("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = () => deny(`subprocess.${name}`);
  for (const protocol of ["node:http", "node:https"]) {
    const transport = require(protocol);
    transport.request = () => deny(`${protocol}.request`);
    transport.get = () => deny(`${protocol}.get`);
  }
  globalThis.fetch = () => deny("fetch");
  const { writeMockArtifacts } = require(path.join(config.root, "scripts/test_collector_integration.cjs"));
  const helper = require(path.join(config.root, "scripts/operating_web_collector.cjs"));
  const original = helper.createOperatingWebCollector;
  let active = 0;
  const record = value => fs.appendFileSync(config.events, `${JSON.stringify(value)}\n`);
  helper.createOperatingWebCollector = options => original({ ...options, spawnImpl(executable, args, settings) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const env = settings.env, keyword = args[1];
    let closed = false;
    active += 1;
    record({ event: "start", keyword, active, workerKey: env.COLLECTOR_WORKER_KEY, engine: env.COLLECTOR_ENGINE,
      pacing: env.NAVER_REQUEST_PACING_ENABLED, web: env.COLLECTOR_WEB_RUNTIME, worker: env.COLLECTOR_WORKER_RUNTIME });
    function close(code, signal = null) {
      if (closed) return;
      closed = true; active -= 1;
      record({ event: "close", keyword, active, code, signal });
      child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
    }
    child.kill = signal => { setImmediate(() => close(null, signal)); return true; };
    setImmediate(async () => {
      try {
        assert.equal(executable, process.execPath);
        assert.equal(path.basename(args[0]), "gyeongnam_glamping_crawl.cjs");
        assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true);
        assert.equal(env.COLLECTOR_WEB_RUNTIME, "1"); assert.equal(env.COLLECTOR_WORKER_RUNTIME, "0");
        assert.equal(env.NAVER_REQUEST_PACING_ENABLED, "0");
        assert.equal(env.NAVER_REQUEST_MIN_INTERVAL_MS, undefined);
        assert.equal(env.NAVER_REQUEST_MAX_CONCURRENCY, undefined);
        assert.equal(env.NAVER_BOOKING_DETAIL_CONCURRENCY, undefined);
        assert.equal(env.COLLECTOR_WORKER_TOKEN, undefined);
        assert.equal(env.GLAMPING_ADMIN_PASSWORD, undefined);
        child.stdout.write("Checking Naver booking stock...\n");
        await delay(keyword.includes("순차") ? 450 : 80);
        if (closed) return;
        const blocked = keyword.includes("차단"), partial = keyword.includes("부분");
        const saved = await writeMockArtifacts(env, keyword, 1, blocked ? "blocked" : partial);
        const runId = `fixture_web_${env.COLLECTOR_RUN_TOKEN}_glamping_${env.RUN_STAMP}`;
        const destination = path.join(env.OUTPUTS_DIR, runId);
        if (saved.runDir !== destination) await fsp.rename(saved.runDir, destination);
        const manifestPath = path.join(destination, "manifest.json");
        const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        delete manifest.workerCollection; delete manifest.scheduledCollection;
        Object.assign(manifest, { outputDir: destination, webCollection: true, collectorRunToken: env.COLLECTOR_RUN_TOKEN,
          executionHost: { role: "operating_web" }, requestPacing: { ...manifest.requestPacing, enabled: false, pacingEnabled: false,
            guardEnabled: true, minIntervalMs: 0, maxConcurrentRequests: null } });
        await fsp.writeFile(manifestPath, JSON.stringify(manifest));
        if (blocked) child.stdout.write("COLLECTOR_PROVIDER_BLOCKED\n");
        child.stdout.write("Writing outputs...\n");
        close(blocked ? 1 : 0);
      } catch (error) { record({ event: "fixture_error", message: error.stack || String(error) }); close(1); }
    });
    return child;
  } });
}

async function main() {
  const tempBase = await fsp.realpath(os.tmpdir());
  const temporary = await fsp.mkdtemp(path.join(tempBase, "operating-web-integration-"));
  let server;
  try {
    const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs"), configDir = path.join(dataDir, "config");
    await fsp.mkdir(configDir, { recursive: true });
    const attempts = path.join(temporary, "forbidden.log"), events = path.join(temporary, "mock-events.jsonl"), preload = path.join(temporary, "mock-preload.cjs");
    await fsp.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify({ root: ROOT, attempts, events })});\n`);
    const logs = [];
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const readEvents = () => fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const spawnCount = () => readEvents().filter(event => event.event === "start").length;
    const startServer = async () => {
      server = spawn(process.execPath, ["--require", preload, path.join(__dirname, "glamping_app_server.cjs")], {
        cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
          ...process.env, NODE_OPTIONS: "", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, OUTPUTS_DIR: outputsDir, CONFIG_DIR: configDir,
          MASTER_DB_PATH: path.join(dataDir, "master_db/test.sqlite"), MASTER_DB_WRITE_MODE: "off", SEED_OUTPUTS_FROM_REPO: "0",
          TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0",
          COLLECTOR_EXECUTION_MODE: "worker", COLLECTOR_WORKER_ID: IDS.manual, COLLECTOR_WORKER_TOKEN: TOKENS.manual,
          COLLECTOR_SCHEDULED_WORKER_ID: IDS.scheduled, COLLECTOR_SCHEDULED_WORKER_TOKEN: TOKENS.scheduled,
          GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
          GLAMPING_B2B_USER: MEMBER.username, GLAMPING_B2B_PASSWORD: MEMBER.password, GLAMPING_B2B_ENABLED: "1",
          NAVER_REQUEST_PACING_ENABLED: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "900", NAVER_REQUEST_MAX_CONCURRENCY: "1",
          NAVER_BOOKING_DETAIL_CONCURRENCY: "1"
        }
      });
      server.stdout.on("data", chunk => logs.push(String(chunk)));
      server.stderr.on("data", chunk => logs.push(String(chunk)));
      await waitUntil(async () => {
        if (server.exitCode !== null) throw new Error(logs.join(""));
        try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
      }, "Operating-web fixture did not start", 15000);
    };
    await startServer();
    let admin = await login(base, ADMIN);
    const member = await login(base, MEMBER);
    const status = async () => (await request(base, "/api/collector-status", admin)).body;
    const payload = (keyword, workerKey = "web") => ({ keyword, workerKey, checkIn: day(0), checkOut: day(1), adults: 2,
      searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", bookingRangeDays: 1,
      detailRankRanges: "1-5", bookingRangePlaceLimit: 5, clientRequestId: `web-test-${workerKey}-${Math.random().toString(36).slice(2)}` });
    const accept = async input => {
      const accepted = await request(base, "/api/crawl?async=1", admin, jsonPost(input));
      assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
      return input.clientRequestId;
    };
    const receipt = async id => (await request(base, `/api/crawl-requests/${id}`, admin)).body;
    const finish = async id => {
      let final;
      await waitUntil(async () => { final = await receipt(id); return final.status !== "pending"; }, `Web receipt ${id} did not finish`);
      const errors = readEvents().filter(event => event.event === "fixture_error");
      assert.deepEqual(errors, []);
      return final;
    };
    const remoteIdle = async () => {
      const remotes = (await status()).workers.filter(worker => worker.workerKey !== "web");
      assert.equal(remotes.length, 2);
      assert.ok(remotes.every(worker => worker.queued === 0 && !worker.activeJobId));
    };
    const derivedFiles = [path.join(dataDir, "history/observations.jsonl"), path.join(dataDir, "company_master/companies.json")];
    const derived = () => Promise.all(derivedFiles.map(file => fsp.readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; })));

    const initial = await status(), web = initial.workers.find(worker => worker.workerKey === "web");
    assert.equal(web.connected, true); assert.equal(web.ready, true); assert.equal(web.configured, true);
    assert.match(web.label || web.name || "", /기본워커/);
    for (const [cookie, expected] of [["", 401], [member, 403]]) {
      assert.equal((await request(base, "/api/crawl?async=1", cookie, jsonPost(payload("인증글램핑")))).response.status, expected);
    }
    assert.equal(spawnCount(), 0);
    const beforePartial = await derived();
    const partial = await finish(await accept(payload("부분글램핑")));
    assert.equal(partial.status, "partial", JSON.stringify(partial));
    assert.ok(partial.result.history == null);
    assert.deepEqual(await derived(), beforePartial);
    await remoteIdle();

    const target = payload("시즌글램핑"), completedId = await accept(target), completed = await finish(completedId);
    assert.equal(completed.status, "complete", JSON.stringify(completed));
    assert.equal(completed.workerKey, "web");
    const runId = completed.result.runId;
    const manifest = JSON.parse(await fsp.readFile(path.join(outputsDir, runId, "manifest.json"), "utf8"));
    assert.equal(manifest.webCollection, true); assert.notEqual(manifest.workerCollection, true); assert.notEqual(manifest.scheduledCollection, true);
    assert.equal(manifest.workerKey, "web"); assert.equal(manifest.executionHost.role, "operating_web");
    assert.equal(manifest.requestPacing.enabled, false); assert.equal(manifest.requestPacing.guardEnabled, true);
    await remoteIdle();
    const beforeReuse = spawnCount();
    for (const workerKey of ["manual", "scheduled"]) {
      const reused = await request(base, "/api/crawl", admin, jsonPost({ ...target, workerKey, clientRequestId: `reuse-web-${workerKey}` }));
      assert.equal(reused.response.status, 200, JSON.stringify(reused.body));
      assert.equal(reused.body.runId, runId); assert.equal(reused.body.reuse.mode, "same_day");
    }
    assert.equal(spawnCount(), beforeReuse);
    await remoteIdle();
    await stopChild(server); await startServer(); admin = await login(base, ADMIN);
    const restored = await receipt(completedId);
    assert.equal(restored.status, "complete"); assert.equal(restored.workerKey, "web"); assert.equal(restored.result.runId, runId);
    assert.equal(spawnCount(), beforeReuse);
    console.log("PASS operating web authorization, complete/partial validation, default speed, cross-worker reuse and restart receipt");

    const sequentialA = await accept(payload("순차첫글램핑"));
    const sequentialB = await accept(payload("순차둘글램핑"));
    await waitUntil(async () => {
      const current = (await status()).workers.find(worker => worker.workerKey === "web");
      return current.crawl?.active === true && Math.max(current.queued || 0, current.crawl?.queueLength || 0) > 0;
    }, "Second web collection was not queued behind the first");
    assert.equal((await request(base, "/api/crawl-status?workerKey=web", admin)).body.active, true);
    assert.equal((await finish(sequentialA)).status, "complete");
    assert.equal((await finish(sequentialB)).status, "complete");
    assert.equal(Math.max(...readEvents().filter(event => event.event === "start").map(event => event.active)), 1);
    await remoteIdle();

    const beforeBlocked = await derived();
    const blocked = await finish(await accept(payload("차단글램핑")));
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.deepEqual(await derived(), beforeBlocked);
    await waitUntil(async () => (await status()).workers.every(worker => worker.halted && worker.errorCode === "COLLECTOR_PROVIDER_BLOCKED"), "Web block did not protect all lanes");
    const afterBlock = spawnCount();
    const refused = await request(base, "/api/crawl?async=1", admin, jsonPost(payload("추가글램핑")));
    assert.equal(refused.response.status, 409); assert.equal(spawnCount(), afterBlock);
    await waitUntil(async () => !(await request(base, "/api/crawl-status?workerKey=web", admin)).body.active, "Blocked web lane remained active");
    assert.equal((await request(base, "/api/collector-reset-halt", admin, jsonPost({ confirm: "resume-after-review", workerKey: "web" }))).response.status, 200);
    assert.ok((await status()).workers.every(worker => worker.halted === false));
    assert.equal(spawnCount(), afterBlock);
    console.log("PASS serial web queue, partial/blocked derived-data hold and cross-lane provider protection/reset");

    // Exercise the opposite direction with a simulated authenticated worker
    // heartbeat. No worker or actual collection process is launched.
    const remoteInput = payload("원격보호글램핑", "manual");
    const remotePending = request(base, "/api/crawl", admin, jsonPost(remoteInput)); remotePending.catch(() => {});
    await waitUntil(async () => (await status()).workers.find(worker => worker.workerKey === "manual").queued === 1, "Remote fixture was not queued");
    const machine = body => ({ ...jsonPost(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKENS.manual}` } });
    const claimed = await request(base, "/api/collector-worker/claim", "", machine({ workerId: IDS.manual, workerKey: "manual", protocolVersion: 1 }));
    assert.equal(claimed.response.status, 200);
    const job = claimed.body.job; assert.ok(job?.id);
    const credentials = { workerId: IDS.manual, leaseToken: job.leaseToken };
    assert.equal((await request(base, `/api/collector-worker/jobs/${job.id}/heartbeat`, "", machine({ ...credentials, providerBlocked: true }))).response.status, 200);
    await waitUntil(async () => (await status()).workers.find(worker => worker.workerKey === "web").halted === true, "Remote provider block did not halt web");
    assert.equal((await request(base, `/api/collector-worker/jobs/${job.id}/fail`, "", machine({ ...credentials, code: "COLLECTOR_PROVIDER_BLOCKED" }))).response.status, 200);
    await remotePending;
    assert.equal((await request(base, "/api/crawl?async=1", admin, jsonPost(payload("원격차단후글램핑")))).response.status, 409);
    assert.equal(spawnCount(), afterBlock);
    assert.equal(fs.existsSync(attempts), false, "No external requests or real crawler subprocesses are permitted");
    assert.deepEqual(readEvents().filter(event => event.event === "fixture_error"), []);
    console.log("PASS remote-provider block also protects basic worker; all collection mocked and outbound IO forbidden");
  } finally {
    await stopChild(server);
    const actual = await fsp.realpath(temporary), relative = path.relative(tempBase, actual);
    assert.equal(path.isAbsolute(relative), false); assert.equal(relative.startsWith(".."), false);
    assert.equal(path.dirname(relative), "."); assert.ok(path.basename(relative).startsWith("operating-web-integration-"));
    await fsp.rm(actual, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
