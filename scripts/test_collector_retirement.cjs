"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { createCollectorRetirementPolicy, parseRetiredWorkerKeys } = require("./lib/collector_retirement.cjs");
const { createKeywordWorkerScheduler, defaultConfig } = require("./keyword_worker_scheduler.cjs");
const { createCollectorBroker } = require("./collector_broker.cjs");

async function directory(t) {
  const root = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, "collector-retirement-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith("collector-retirement-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("retirement defaults preserve every lane and invalid env fails closed", () => {
  assert.deepEqual(parseRetiredWorkerKeys(), []);
  assert.deepEqual(parseRetiredWorkerKeys(" scheduled, manual,scheduled "), ["scheduled", "manual"]);
  for (const invalid of ["bogus", "scheduled,", "scheduled manual", ["scheduled"]]) assert.throws(() => parseRetiredWorkerKeys(invalid), /INVALID/);
  const defaults = createCollectorRetirementPolicy();
  for (const key of ["web", "manual", "scheduled"]) {
    defaults.assertAdmission(key);
    assert.equal(defaults.workerStatus(key, { ready: true }).ready, true);
    assert.equal(defaults.retirementStatus(key).retired, false);
  }
  const policy = createCollectorRetirementPolicy("scheduled");
  assert.throws(() => policy.assertAdmission("scheduled"), error => error.statusCode === 409 && error.code === "COLLECTOR_WORKER_RETIRED");
  for (const key of ["web", "manual"]) policy.assertAdmission(key);
  const history = [{ status: "complete", runId: "retained" }];
  const config = { enabled: true, keywords: ["경남글램핑"] };
  const status = policy.scheduleStatus("scheduled", { enabled: true, nextRunAt: "future", config, latest: history });
  assert.equal(status.enabled, false); assert.equal(status.storedEnabled, true); assert.equal(status.nextRunAt, null);
  assert.equal(status.config, config); assert.equal(status.config.enabled, true); assert.equal(status.latest, history);
});

test("retired real scheduler preserves enabled config, receipts and exclusive retries, creates no timer or occurrence", async t => {
  const dataDir = await directory(t), time = new Date("2026-10-12T05:00:00Z");
  const policy = createCollectorRetirementPolicy("scheduled");
  let runs = 0, timers = 0;
  const original = createKeywordWorkerScheduler({ dataDir, workerKey: "scheduled", now: () => time,
    beforeNewImmediateRun: () => policy.assertAdmission("scheduled"),
    beforeImmediateRun: () => policy.assertAdmission("scheduled"), setIntervalImpl: () => { timers++; },
    runCrawler: async () => { runs++; }, getFreeBytes: async () => 1024 ** 3 });
  const config = { ...defaultConfig(time), enabled: true, keywords: ["경남글램핑"] };
  const configFile = path.join(dataDir, "config", "keyword-worker-schedule.json");
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config));
  const before = await fs.readFile(configFile);
  const scheduler = policy.scheduler("scheduled", original);
  const status = await scheduler.start();
  assert.equal(status.retired, true); assert.equal(status.enabled, false); assert.equal(status.config.enabled, true);
  assert.equal(await scheduler.tick(), null); assert.equal(timers, 0); assert.equal(runs, 0);
  assert.deepEqual(await fs.readFile(configFile), before);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "history", "keyword-worker-schedule")), []);
  assert.throws(() => scheduler.updateConfig({ keywords: ["가평글램핑"] }), /인사이트/);
  assert.throws(() => scheduler.setEnabled(true), /인사이트/);
  await assert.rejects(scheduler.enqueueNow({ requestId: "new_retired_request" }), { code: "COLLECTOR_WORKER_RETIRED" });
  assert.deepEqual(await fs.readdir(path.join(dataDir, "history", "keyword-worker-schedule")), []);
  await fs.writeFile(configFile, JSON.stringify({ ...config, keywords: [] }));
  await assert.rejects(scheduler.enqueueNow({ requestId: "retired_empty_config" }), { code: "COLLECTOR_WORKER_RETIRED" });
  await fs.writeFile(configFile, before);
  // Existing terminal request retries must remain a lookup, with no admission or redispatch.
  const requestId = "old_retired_request";
  const id = "manual_" + require("node:crypto").createHash("sha256").update(requestId).digest("hex");
  const receipt = { version: 1, id, day: "2026-10-12", trigger: "manual", workerKey: "scheduled", status: "complete",
    createdAt: time.toISOString(), scheduledAt: time.toISOString(), startedAt: time.toISOString(), finishedAt: time.toISOString(),
    config, items: [{ keyword: "경남글램핑", status: "complete", runId: "retained_glamping_20261012_050000" }] };
  const receiptFile = path.join(dataDir, "history", "keyword-worker-schedule", `${id}.json`);
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  const bytes = await fs.readFile(receiptFile);
  assert.equal((await scheduler.enqueueNow({ requestId })).id, id);
  assert.equal((await scheduler.status()).latest[0].items[0].runId, receipt.items[0].runId);
  assert.deepEqual(await fs.readFile(receiptFile), bytes); assert.equal(runs, 0);
  await scheduler.setEnabled(false);
  assert.equal(JSON.parse(await fs.readFile(configFile, "utf8")).enabled, false);
});

test("retired broker authenticates claim, never leases queued work and permits existing lease finalization", async t => {
  const dataDir = await directory(t); let canClaim = true;
  const token = "retirement-fixture-token-1234567890123456789", workerId = "retirement-fixture-worker";
  const broker = createCollectorBroker({ dataDir, outputsDir: path.join(dataDir, "outputs"), token, workerId,
    workerKey: "scheduled", canClaim: () => canClaim });
  await broker.initialize();
  const server = http.createServer(async (req, res) => {
    if (!await broker.handleHttp(req, res)) { res.writeHead(404); res.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/collector-worker-scheduled`;
  async function post(route, body, secret = token) {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const submit = () => broker.submit({ keyword: "모의글램핑", env: {}, payload: { workerKey: "scheduled", trigger: "manual" } });
  const first = await submit();
  const identity = { workerId, workerKey: "scheduled", protocolVersion: 1 };
  const claimed = await post("/claim", identity); assert.equal(claimed.status, 200); assert.equal(claimed.body.job.id, first.id);
  await submit(); canClaim = false;
  assert.equal((await post("/claim", identity, "wrong-token")).status, 401);
  assert.equal((await post("/claim", { ...identity, workerId: "wrong-worker" })).status, 403);
  const before = await fs.readFile(path.join(dataDir, "collector", "jobs.json"));
  const refused = await post("/claim", identity);
  assert.deepEqual(refused.body, { job: null, retired: true }); assert.equal(refused.status, 200);
  assert.deepEqual(await fs.readFile(path.join(dataDir, "collector", "jobs.json")), before);
  const lease = { workerId, leaseToken: claimed.body.job.leaseToken };
  assert.equal((await post(`/jobs/${first.id}/heartbeat`, { ...lease, stage: "inventory" })).status, 200);
  assert.equal((await post(`/jobs/${first.id}/fail`, { ...lease, code: "COLLECTOR_TEST_FINALIZED" })).status, 200);
  assert.equal((await broker.getJob(first.id)).status, "failed");
  assert.equal((await broker.status()).queued, 1);
  assert.equal((await post("/claim", identity)).body.job, null);
});
