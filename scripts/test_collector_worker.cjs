"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { workerOptions, runWorker, runJob, stageReader } = require("./collector_worker.cjs");

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const TOKEN = "local-test-only-collector-token-1234567890";
const leaseToken = "local_test_only_lease_12345678901234567890";
const baseJob = (id = "job_1") => ({ id, keyword: "산청글램핑", env: {
  CHECK_IN: "2026-09-23", CHECK_OUT: "2026-10-23", SEARCH_MODE: "keyword", COLLECTION_MODE: "precision",
  COLLECTION_PURPOSE: "revenue_detail", BOOKING_RANGE_DAYS: "31", SCHEDULED_COLLECTION: "1"
}, context: { historicalBookingBusinesses: [{ placeId: "123", businessId: "456" }] }, leaseToken, leaseMs: 1000 });

async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function reply(res, value, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }

async function fixture(settings = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-worker-test-"));
  const state = { requests: [], uploads: [], completions: [], failures: [], claims: 0, heartbeats: 0, spawned: [], kills: [], events: [], serverErrors: [] };
  const jobs = [...(settings.jobs || [baseJob()])];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      const url = new URL(req.url, "http://localhost");
      const raw = await body(req);
      const json = req.method === "PUT" ? null : JSON.parse(raw.toString("utf8"));
      state.requests.push({ method: req.method, path: url.pathname });
      if (settings.route && await settings.route({ req, res, url, raw, json, state })) return;
      if (url.pathname.endsWith("/claim")) {
        state.claims++;
        assert.equal(json.protocolVersion, 1);
        reply(res, { job: jobs.shift() || null });
      } else if (url.pathname.endsWith("/heartbeat")) {
        state.heartbeats++;
        assert.equal(json.leaseToken, leaseToken);
        if (settings.heartbeat) await settings.heartbeat({ req, res, json, state, url });
        else reply(res, { cancelled: false });
      } else if (url.pathname.endsWith("/files")) {
        assert.equal(req.headers["x-collector-lease"], leaseToken);
        assert.equal(req.headers["x-collector-worker"], "fixture-worker");
        assert.equal(Number(req.headers["content-length"]), raw.length);
        assert.equal(req.headers["x-content-sha256"], crypto.createHash("sha256").update(raw).digest("hex"));
        state.uploads.push({ path: url.searchParams.get("path"), body: raw });
        if (settings.upload) await settings.upload({ req, res, state, url });
        else reply(res, { ok: true });
      } else if (url.pathname.endsWith("/complete")) {
        state.completions.push(json);
        if (settings.complete) await settings.complete({ req, res, json, state });
        else reply(res, { ok: true });
      } else if (url.pathname.endsWith("/fail")) {
        state.failures.push(json);
        if (settings.fail) await settings.fail({ req, res, json, state });
        else reply(res, { ok: true });
      } else reply(res, { ok: false }, 404);
    } catch (error) { state.serverErrors.push(error); if (!res.headersSent) reply(res, { ok: false }, 500); else res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const spawnImpl = (executable, args, config) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    child.close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      child.stdout.end(); child.stderr.end();
      child.emit("close", code, signal);
    };
    child.kill = (signal) => { state.kills.push(signal); setImmediate(() => child.close(null, signal)); return true; };
    state.spawned.push({ executable, args, config, child });
    setImmediate(async () => {
      try {
        if (settings.crawl) await settings.crawl({ child, config, state, directory });
        else { await writeArtifacts(config.env); child.close(); }
      } catch (error) { state.serverErrors.push(error); child.close(1); }
    });
    return child;
  };
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_SERVER_URL: serverUrl, COLLECTOR_ALLOW_LOCAL_HTTP: "1",
    COLLECTOR_WORKER_TOKEN: TOKEN, COLLECTOR_WORKER_ID: "fixture-worker", PATH: process.env.PATH || process.env.Path || "",
    NODE_OPTIONS: "--require unwanted.cjs", APP_PASSWORD: "DO_NOT_INHERIT_PASSWORD", DATABASE_URL: "DO_NOT_INHERIT_DATABASE", RENDER_API_KEY: "DO_NOT_INHERIT_KEY" }, {
    workDir: path.join(directory, "jobs"), spawnImpl, maxJobs: 1, pollMs: 5, heartbeatMs: 20, heartbeatTimeoutMs: 100,
    requestTimeoutMs: 300, retryMs: 5, killTimeoutMs: 20, logger: (event) => state.events.push(event), ...settings.options
  });
  return { directory, state, options, server,
    close: async () => {
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(directory, { recursive: true, force: true });
      if (state.serverErrors.length) throw state.serverErrors[0];
    } };
}

async function writeArtifacts(env) {
  const run = path.join(env.OUTPUTS_DIR, "sancheong_glamping_20260923_140000");
  await fs.mkdir(path.join(run, "details"), { recursive: true });
  await fs.writeFile(path.join(run, "manifest.json"), JSON.stringify({ keyword: "산청글램핑", checkIn: env.CHECK_IN, collectedAt: "2026-09-23T05:00:00Z" }));
  await fs.writeFile(path.join(run, "details", "예약.json"), JSON.stringify([{ date: env.CHECK_IN, stock: 3, bookingCount: 0 }]));
  await fs.writeFile(path.join(run, "결과.csv"), "place_id,업체명\n123,fixture\n");
  return run;
}

test("disabled worker cannot contact a server; secure URL/token configuration is mandatory", async () => {
  assert.deepEqual(await runWorker(workerOptions({})), { enabled: false, jobs: 0 });
  const env = { COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_WORKER_TOKEN: TOKEN };
  for (const url of ["http://example.com", "http://127.0.0.1", "https://user:pass@example.com", "https://example.com?token=x", "https://example.com/path"]) {
    assert.throws(() => workerOptions({ ...env, COLLECTOR_SERVER_URL: url }), /COLLECTOR_CONFIGURATION_INVALID/);
  }
  assert.throws(() => workerOptions({ ...env, COLLECTOR_SERVER_URL: "https://example.com", COLLECTOR_WORKER_TOKEN: "short" }), /COLLECTOR_CONFIGURATION_INVALID/);
  assert.equal(workerOptions({ ...env, COLLECTOR_SERVER_URL: "https://example.com" }).workerId, "staydatalab-collector");
});

test("one claim spawns once with isolated environment, streams actual artifacts and completes with matching hashes", async () => {
  const f = await fixture({ crawl: async ({ child, config }) => {
    assert.equal(config.windowsHide, true); assert.equal(config.shell, false);
    for (const key of ["COLLECTOR_WORKER_TOKEN", "APP_PASSWORD", "DATABASE_URL", "RENDER_API_KEY", "NODE_OPTIONS"]) assert.equal(config.env[key], undefined);
    assert.equal(config.env.COLLECTOR_WORKER_RUNTIME, "1");
    assert.equal(config.env.SCHEDULED_COLLECTION, "1");
    const history = JSON.parse(await fs.readFile(config.env.HISTORY_BOOKING_BUSINESS_CONTEXT_FILE, "utf8"));
    assert.deepEqual(history, [{ placeId: "123", businessId: "456" }]);
    assert.ok(config.env.DATA_DIR.startsWith(config.cwd + path.sep));
    child.stdout.write(`secret=${TOKEN}\nChecking Naver booking stock...\n`);
    child.stderr.write("sensitive fixture failure must be discarded\n");
    await writeArtifacts(config.env); child.close();
  } });
  try {
    assert.equal((await runWorker(f.options)).jobs, 1);
    assert.equal(f.state.spawned.length, 1); assert.equal(f.state.claims, 1);
    assert.equal(f.state.uploads.length, 3); assert.equal(f.state.completions.length, 1);
    const complete = f.state.completions[0];
    assert.equal(complete.runId, "sancheong_glamping_20260923_140000");
    for (const file of complete.files) {
      assert.equal(Object.hasOwn(file, "absolute"), false);
      const upload = f.state.uploads.find((item) => item.path === file.path);
      assert.equal(file.size, upload.body.length);
      assert.equal(file.sha256, crypto.createHash("sha256").update(upload.body).digest("hex"));
    }
    assert.deepEqual(await fs.readdir(f.options.workDir), []);
    assert.equal(JSON.stringify(f.state.events).includes(TOKEN), false);
  } finally { await f.close(); }
});

test("upload and lost-completion-ACK retries reuse artifacts without rerunning the crawler", async () => {
  let uploadAttempts = 0;
  const f = await fixture({ options: { retryMs: 30 },
    heartbeat: ({ res, state }) => reply(res, { cancelled: false }, state.completions.length ? 409 : 200),
    upload: ({ res }) => reply(res, { ok: ++uploadAttempts > 1 }, uploadAttempts === 1 ? 503 : 200),
    complete: ({ res, state }) => state.completions.length === 1 ? res.destroy() : reply(res, { ok: true }) });
  try {
    await runWorker(f.options);
    assert.equal(f.state.spawned.length, 1);
    assert.equal(f.state.uploads.length, 4);
    assert.equal(f.state.completions.length, 2);
    assert.deepEqual(f.state.completions[0], f.state.completions[1]);
  } finally { await f.close(); }
});

test("completion cancellation acknowledgement is not reported as a completed crawl", async () => {
  const f = await fixture({ complete: ({ res }) => reply(res, { ok: true, cancelled: true }) });
  try {
    const result = await runJob(baseJob(), f.options);
    assert.equal(result.status, "cancelled"); assert.equal(result.acknowledged, true);
    assert.equal(result.code, "COLLECTOR_CANCELLED");
    assert.equal(f.state.failures.length, 0);
    assert.ok((await fs.readdir(path.join(result.retainedDirectory, "outputs"))).length > 0);
  } finally { await f.close(); }
});

test("failed upload retains local artifacts and reports only a generic failure code", async () => {
  const f = await fixture({ upload: ({ res }) => reply(res, { ok: false }, 503) });
  try {
    const result = await runJob(baseJob(), f.options);
    assert.equal(result.status, "failed"); assert.equal(result.code, "COLLECTOR_UPLOAD_FAILED");
    assert.equal(result.acknowledged, true); assert.equal(f.state.uploads.length, 3);
    assert.equal(f.state.spawned.length, 1);
    assert.equal(f.state.failures[0].code, "COLLECTOR_UPLOAD_FAILED");
    assert.deepEqual(Object.keys(f.state.failures[0]).sort(), ["code", "leaseToken", "workerId"]);
    assert.ok((await fs.readdir(path.join(result.retainedDirectory, "outputs"))).length > 0);
  } finally { await f.close(); }
});

test("a natural nonzero exit can publish a bounded worker failure receipt without claiming completion", async () => {
  const f = await fixture({ options: { maxJobs: 2 }, crawl: async ({ child, config }) => {
    const run = path.join(config.env.OUTPUTS_DIR, "sancheong_glamping_20260923_140000");
    await fs.mkdir(run);
    await fs.writeFile(path.join(run, "manifest.json"), JSON.stringify({ keyword: "산청글램핑", workerCollection: true,
      collectionFailed: true, collectionQuality: { status: "blocked" }, files: [], fileRoles: {}, counts: {} }));
    child.close(1);
  } });
  try {
    const result = await runWorker(f.options);
    assert.equal(result.jobs, 1); assert.equal(f.state.claims, 1); assert.equal(f.state.spawned.length, 1);
    assert.equal(f.state.uploads.length, 1); assert.equal(f.state.completions.length, 1);
    assert.equal(f.state.failures.length, 0);
    assert.equal(f.state.events.at(-1).event, "collector_failure_receipt_saved");
    assert.equal(f.state.events.at(-1).code, "COLLECTOR_PROVIDER_BLOCKED");
  } finally { await f.close(); }
});

test("a nonzero exit with an ordinary or unrecognized manifest never publishes the run", async () => {
  const f = await fixture({ crawl: async ({ child, config }) => { await writeArtifacts(config.env); child.close(1); } });
  try {
    const result = await runJob(baseJob(), f.options);
    assert.equal(result.code, "COLLECTOR_CRAWL_FAILED"); assert.equal(result.acknowledged, true);
    assert.equal(f.state.uploads.length, 0); assert.equal(f.state.completions.length, 0);
    assert.ok((await fs.readdir(path.join(result.retainedDirectory, "outputs"))).length > 0);
  } finally { await f.close(); }
});

test("heartbeat lease/auth failure kills the child immediately and never claims another job", async () => {
  for (const status of [401, 409]) {
    const f = await fixture({ options: { maxJobs: 2 }, heartbeat: ({ res, state }) => reply(res, { cancelled: false }, state.heartbeats === 1 ? 200 : status),
      crawl: async ({ config }) => { await writeArtifacts(config.env); } });
    try {
      const result = await runWorker(f.options);
      assert.equal(result.jobs, 1); assert.equal(f.state.claims, 1);
      assert.deepEqual(f.state.kills, ["SIGTERM"]);
      assert.equal(f.state.failures[0].code, "COLLECTOR_HEARTBEAT_FAILED");
      assert.equal(f.state.uploads.length, 0);
    } finally { await f.close(); }
  }
});

test("heartbeat network timeout stops crawling within the lease and missing terminal ACK stops polling", async () => {
  const f = await fixture({ options: { maxJobs: 2, heartbeatTimeoutMs: 50 },
    heartbeat: ({ res, state }) => { if (state.heartbeats === 1) reply(res, { cancelled: false }); },
    fail: ({ res }) => reply(res, { ok: false }, 503), crawl: async () => {} });
  try {
    const start = Date.now();
    await assert.rejects(runWorker(f.options), /COLLECTOR_TERMINAL_ACK_REQUIRED/);
    assert.ok(Date.now() - start < 1000);
    assert.deepEqual(f.state.kills, ["SIGTERM"]); assert.equal(f.state.claims, 1);
  } finally { await f.close(); }
});

test("cancellation waits for child close and fail ACK before the next claim", async () => {
  let firstClosed = false;
  const f = await fixture({ jobs: [baseJob("job_1"), baseJob("job_2")], options: { maxJobs: 2 },
    heartbeat: ({ res, state, url }) => reply(res, { cancelled: url.pathname.includes("job_1") && state.heartbeats > 1 }),
    crawl: async ({ child, config, state }) => {
      if (state.spawned.length === 1) { child.once("close", () => { firstClosed = true; }); return; }
      assert.equal(firstClosed, true); assert.equal(state.failures.length, 1);
      await writeArtifacts(config.env); child.close();
    }, fail: ({ res, json }) => { assert.equal(firstClosed, true); assert.equal(json.code, "COLLECTOR_CANCELLED"); reply(res, { ok: true }); } });
  try {
    assert.equal((await runWorker(f.options)).jobs, 2);
    assert.equal(f.state.spawned.length, 2); assert.equal(f.state.claims, 2);
    assert.equal(f.state.completions.length, 1);
  } finally { await f.close(); }
});

test("shutdown aborts the active crawler, acknowledges failure and preserves its artifacts", async () => {
  const controller = new AbortController();
  const f = await fixture({ options: { signal: controller.signal, maxJobs: 2 }, crawl: async ({ config }) => {
    await writeArtifacts(config.env); controller.abort();
  } });
  try {
    await runWorker(f.options);
    assert.deepEqual(f.state.kills, ["SIGTERM"]);
    assert.equal(f.state.failures[0].code, "COLLECTOR_SHUTDOWN");
    assert.equal(f.state.claims, 1);
    assert.equal((await fs.readdir(f.options.workDir)).length, 1);
  } finally { await f.close(); }
});

test("server-provided executable settings, local paths and malformed context cannot reach a child", async () => {
  for (const change of [job => { job.env.NODE_OPTIONS = "--require injected.cjs"; }, job => { job.env.DATA_DIR = "/var/data"; },
    job => { job.context.historicalBookingBusinesses = [{ placeId: "../secret", businessId: "123" }]; }]) {
    const job = baseJob(); change(job);
    const f = await fixture();
    try {
      const result = await runJob(job, f.options);
      assert.equal(result.code, "COLLECTOR_JOB_INVALID");
      assert.equal(f.state.spawned.length, 0); assert.equal(f.state.uploads.length, 0);
    } finally { await f.close(); }
  }
});

test("artifact links and multiple run directories are rejected before uploads", async () => {
  for (const variant of ["junction", "hardlink", "extra-run"]) {
    const f = await fixture({ crawl: async ({ child, config, directory }) => {
      const run = await writeArtifacts(config.env);
      if (variant === "extra-run") await fs.mkdir(path.join(config.env.OUTPUTS_DIR, "unexpected_run"));
      else if (variant === "hardlink") await fs.link(path.join(run, "manifest.json"), path.join(run, "linked.json"));
      else {
        const outside = path.join(directory, "outside"); await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "sensitive.txt"), "DO_NOT_UPLOAD");
        await fs.symlink(outside, path.join(run, "outside"), process.platform === "win32" ? "junction" : "dir");
      }
      child.close();
    } });
    try {
      const result = await runJob(baseJob(), f.options);
      assert.equal(result.code, "COLLECTOR_ARTIFACT_INVALID"); assert.equal(f.state.uploads.length, 0);
    } finally { await f.close(); }
  }
});

test("progress accepts only exact recognized lines and never forwards raw stdout", () => {
  const stages = [];
  const read = stageReader(stage => stages.push(stage));
  read(Buffer.from("secret=do-not-send\nChecking Naver "));
  read(Buffer.from("booking stock...\nWriting outputs...\n"));
  assert.deepEqual(stages, ["inventory", "save"]);
});

(async () => {
  for (const { name, run } of cases) { await run(); console.log(`PASS ${name}`); }
  console.log(`${cases.length} collector worker tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
