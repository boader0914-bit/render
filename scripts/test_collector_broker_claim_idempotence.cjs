"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createCollectorBroker, LEASE_MS } = require("./collector_broker.cjs");

const TOKEN = "test-only-collector-token-32-characters-long";
const WORKER = "staydatalab-collector";
const BASE = "/api/collector-worker";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "collector-claim-idempotence-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs");
  let now = Date.parse("2026-10-20T00:00:00Z");
  const options = { dataDir, outputsDir, token: TOKEN, workerId: WORKER, workerKey: "manual", now: () => now };
  const broker = createCollectorBroker(options);
  await broker.initialize();
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("collector-claim-idempotence-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { broker, options, dataDir, outputsDir, advance: ms => { now += ms; },
    ledger: async () => JSON.parse(await fs.readFile(path.join(dataDir, "collector", "jobs.json"), "utf8")) };
}

async function request(broker, method, route, body, { headers = {}, loseReply = false } = {}) {
  const binary = Buffer.isBuffer(body), buffer = binary ? body : Buffer.from(JSON.stringify(body ?? {}));
  const req = Readable.from([buffer]);
  Object.assign(req, { method, url: route, headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(buffer.length),
    "content-type": binary ? "application/octet-stream" : "application/json", ...headers } });
  let status, response, lostResponse;
  const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(value) {
    if (loseReply) { lostResponse = JSON.parse(value); throw new Error("simulated response lost after commit"); }
    response = JSON.parse(value);
  } };
  assert.equal(await broker.handleHttp(req, res, new URL(route, "http://local.test")), true);
  return { status, body: response, lostResponse };
}

const claimBody = nonce => ({ workerId: WORKER, workerKey: "manual", protocolVersion: 1,
  ...(nonce === undefined ? {} : { claimRequestId: nonce }) });
const claim = (broker, nonce, options) => request(broker, "POST", `${BASE}/claim`, claimBody(nonce), options);
const identity = lease => ({ workerId: WORKER, leaseToken: lease.leaseToken });
function jobInput(payloadOverrides = {}, envOverrides = {}) {
  const scope = { keyword: "경남글램핑", checkIn: "2026-10-20", checkOut: "2026-11-09", adults: 2,
    searchMode: "keyword", searchIntent: "lodging", searchRegion: "", searchScope: "nationwide",
    collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-20", bookingRangeDays: 21,
    bookingRangePlaceLimit: 0, productMode: "all", dayUseMode: "inspect", sourceRole: "admin", collectionSource: "admin_search",
    workerKey: "manual", trigger: "scheduled", scheduledCollection: true, ...payloadOverrides };
  const fields = { CHECK_IN: "checkIn", CHECK_OUT: "checkOut", ADULTS: "adults", SEARCH_MODE: "searchMode", SEARCH_INTENT: "searchIntent",
    SEARCH_REGION: "searchRegion", SEARCH_SCOPE: "searchScope", COLLECTION_MODE: "collectionMode", COLLECTION_PURPOSE: "collectionPurpose",
    DETAIL_RANK_RANGES: "detailRankRanges", BOOKING_RANGE_DAYS: "bookingRangeDays", BOOKING_RANGE_PLACE_LIMIT: "bookingRangePlaceLimit",
    PRODUCT_MODE: "productMode", DAY_USE_MODE: "dayUseMode", SOURCE_ROLE: "sourceRole", COLLECTION_SOURCE: "collectionSource" };
  const env = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, String(scope[field])]));
  env.SCHEDULED_COLLECTION = scope.trigger === "scheduled" ? "1" : "0";
  return { keyword: scope.keyword, env: { ...env, ...envOverrides }, payload: scope, context: { historicalBookingBusinesses: [] } };
}
function artifacts(lease, input, extra = {}) {
  const runId = `qa_manual_${lease.env.COLLECTOR_RUN_TOKEN}_glamping_20261020_090000`;
  const manifest = { ...input.payload, outputDir: `/worker/outputs/${runId}`, collectedAt: "2026-10-20T00:01:00Z",
    workerCollection: true, jobId: lease.id, collectorEngine: "current-manual-v2", collectorRunToken: lease.env.COLLECTOR_RUN_TOKEN,
    naverAttemptedQueries: [{ status: 200 }], fileRoles: { overall: "rows.csv" }, files: ["rows.csv"],
    detailJsonFiles: [{ file: "details/items.json", itemCount: 1 }],
    counts: { naverOverall: 2, naverBookingStockEligible: 2, naverBookingStockChecked: 2, naverBookingStockSucceeded: 2,
      naverOtaObservationChecked: 2, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 42, naverScheduleSucceeded: 42, naverScheduleFailed: 0, naverScheduleBlocked: 0 }, ...extra };
  const contents = { "manifest.json": Buffer.from(JSON.stringify(manifest)), "rows.csv": Buffer.from("name,detail\nfixture,@json-file:details/items.json\n"),
    "details/items.json": Buffer.from('[{"date":"2026-10-20","stock":1}]') };
  return { runId, contents, files: Object.entries(contents).map(([file, buffer]) => ({ path: file, size: buffer.length, sha256: sha(buffer) })) };
}
async function upload(broker, lease, name, buffer) {
  return request(broker, "PUT", `${BASE}/jobs/${lease.id}/files?path=${encodeURIComponent(name)}`, buffer,
    { headers: { "x-collector-worker": WORKER, "x-collector-lease": lease.leaseToken, "x-content-sha256": sha(buffer) } });
}
async function finish(broker, lease, bundle, options) {
  for (const [name, buffer] of Object.entries(bundle.contents)) {
    const response = await upload(broker, lease, name, buffer);
    assert.equal(response.status, 200, response.body?.error);
  }
  return request(broker, "POST", `${BASE}/jobs/${lease.id}/complete`, { ...identity(lease), runId: bundle.runId, files: bundle.files }, options);
}

test("a lost claim reply replays the same lease without extending it or persisting its secret", async t => {
  const f = await fixture(t), firstJob = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  const lost = await claim(f.broker, nonce.toUpperCase(), { loseReply: true });
  assert.equal(lost.status, 200); assert.equal(lost.body, undefined);
  const lease = lost.lostResponse.job;
  assert.equal(lease.id, firstJob.id);
  const before = (await f.ledger()).jobs[0];
  f.advance(5000);
  const replay = await claim(f.broker, nonce);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.job, lease);
  const after = (await f.ledger()).jobs[0];
  for (const key of ["leaseHash", "leaseExpiresAt", "startedAt", "updatedAt"]) assert.equal(after[key], before[key]);
  assert.equal(after.claimRequestId, nonce); assert.equal(after.leaseHash, sha(lease.leaseToken));
  const claimDir = path.join(f.dataDir, "collector", "claims"), files = await fs.readdir(claimDir);
  assert.deepEqual(files, [`${sha(nonce)}.json`]);
  const disk = JSON.stringify(await f.ledger()) + await fs.readFile(path.join(claimDir, files[0]), "utf8");
  assert.equal(disk.includes(lease.leaseToken), false);
  const exposed = JSON.stringify([await f.broker.getJob(lease.id), await f.broker.status()]);
  assert.equal(exposed.includes(lease.leaseToken), false); assert.equal(exposed.includes(nonce), false);
});

test("concurrent retries share one lease while a different logical claim cannot steal queued work", async t => {
  const f = await fixture(t), one = await f.broker.submit(jobInput()), two = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  const replies = await Promise.all([claim(f.broker, nonce), claim(f.broker, nonce)]);
  assert.deepEqual(replies[0].body.job, replies[1].body.job); assert.equal(replies[0].body.job.id, one.id);
  assert.deepEqual((await claim(f.broker, crypto.randomUUID())).body, { job: null });
  assert.equal((await f.broker.getJob(two.id)).status, "queued");
  assert.equal((await f.ledger()).jobs.filter(job => job.status === "leased").length, 1);
});

test("the first valid heartbeat acknowledges the claim; invalid input and wrong authentication do not", async t => {
  const f = await fixture(t); await f.broker.submit(jobInput()); const nonce = crypto.randomUUID();
  const lease = (await claim(f.broker, nonce)).body.job;
  const heartbeat = body => request(f.broker, "POST", `${BASE}/jobs/${lease.id}/heartbeat`, { ...identity(lease), ...body });
  assert.equal((await heartbeat({ stage: "invalid" })).status, 400);
  assert.deepEqual((await claim(f.broker, nonce)).body.job, lease);
  assert.equal((await claim(f.broker, nonce, { headers: { authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await heartbeat({ stage: "rank_main" })).status, 200);
  assert.ok((await f.ledger()).jobs[0].claimAcknowledgedAt);
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
});

test("a completed upload also prevents unacknowledged claim replay", async t => {
  const f = await fixture(t); await f.broker.submit(jobInput()); const nonce = crypto.randomUUID();
  const lease = (await claim(f.broker, nonce)).body.job;
  assert.equal((await upload(f.broker, lease, "rows.csv", Buffer.from("name\nfixture\n"))).status, 200);
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
});

test("an upload still streaming cannot replay a claim before its upload receipt is persisted", async t => {
  const f = await fixture(t); await f.broker.submit(jobInput()); const nonce = crypto.randomUUID();
  const lease = (await claim(f.broker, nonce)).body.job, buffer = Buffer.from("name\nfixture\n");
  let started, release;
  const entered = new Promise(resolve => { started = resolve; }), continuation = new Promise(resolve => { release = resolve; });
  const req = Readable.from((async function* () { started(); yield buffer.subarray(0, 1); await continuation; yield buffer.subarray(1); })());
  Object.assign(req, { method: "PUT", url: `${BASE}/jobs/${lease.id}/files?path=rows.csv`, headers: { authorization: `Bearer ${TOKEN}`,
    "content-length": String(buffer.length), "x-content-sha256": sha(buffer), "x-collector-worker": WORKER, "x-collector-lease": lease.leaseToken } });
  let status;
  const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end() {} };
  const pending = f.broker.handleHttp(req, res, new URL(req.url, "http://local.test"));
  await entered;
  try { assert.deepEqual((await claim(f.broker, nonce)).body, { job: null }); }
  finally { release(); await pending; }
  assert.equal(status, 200);
});

test("expiry never reuses the old nonce for a new queued job after an explicit halt reset", async t => {
  const f = await fixture(t), first = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  await claim(f.broker, nonce); f.advance(LEASE_MS);
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
  assert.equal((await f.broker.getJob(first.id)).errorCode, "COLLECTOR_LEASE_EXPIRED");
  await f.broker.resetHalt(); const next = await f.broker.submit(jobInput());
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
  assert.equal((await f.broker.getJob(next.id)).status, "queued");
  assert.equal((await claim(f.broker, crypto.randomUUID())).body.job.id, next.id);
});

test("a restart interrupts an unacknowledged lease and its nonce cannot claim later work", async t => {
  const f = await fixture(t), first = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  await claim(f.broker, nonce);
  const restarted = createCollectorBroker(f.options); await restarted.initialize();
  assert.equal((await restarted.getJob(first.id)).errorCode, "COLLECTOR_RESTART_INTERRUPTED");
  await restarted.resetHalt(); const next = await restarted.submit(jobInput());
  assert.deepEqual((await claim(restarted, nonce)).body, { job: null });
  assert.equal((await restarted.getJob(next.id)).status, "queued");
});

test("terminal completion ACK retries stay idempotent and the terminal nonce never claims the next job", async t => {
  const f = await fixture(t), input = jobInput(); await f.broker.submit(input); const nonce = crypto.randomUUID();
  const lease = (await claim(f.broker, nonce)).body.job, bundle = artifacts(lease, input);
  const lost = await finish(f.broker, lease, bundle, { loseReply: true });
  assert.equal(lost.status, 200); assert.deepEqual(lost.lostResponse, { ok: true });
  const next = await f.broker.submit(jobInput());
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
  const retry = await request(f.broker, "POST", `${BASE}/jobs/${lease.id}/complete`, { ...identity(lease), runId: bundle.runId, files: bundle.files });
  assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ok: true });
  assert.equal((await f.broker.getJob(next.id)).status, "queued");
  assert.equal((await claim(f.broker, crypto.randomUUID())).body.job.id, next.id);
});

test("nonce tombstones survive the bounded ledger and broker restart", async t => {
  const f = await fixture(t), first = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  const lease = (await claim(f.broker, nonce)).body.job;
  assert.equal((await request(f.broker, "POST", `${BASE}/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_TEST_FAILURE" })).status, 200);
  await f.broker.resetHalt();
  for (let index = 0; index < 201; index++) { const job = await f.broker.submit(jobInput()); await f.broker.cancel(job.id); }
  const ledger = await f.ledger(); assert.equal(ledger.jobs.length, 200); assert.equal(ledger.jobs.some(job => job.id === first.id), false);
  assert.equal((await f.broker.getJob(first.id)).status, "failed");
  const restarted = createCollectorBroker(f.options); await restarted.initialize();
  const next = await restarted.submit(jobInput());
  assert.deepEqual((await claim(restarted, nonce)).body, { job: null });
  assert.equal((await restarted.getJob(next.id)).status, "queued");
  assert.equal((await claim(restarted, crypto.randomUUID())).body.job.id, next.id);
});

test("malformed claim IDs are rejected before leasing and legacy claim requests remain compatible", async t => {
  const f = await fixture(t), job = await f.broker.submit(jobInput());
  for (const nonce of [null, 1, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000", `${crypto.randomUUID()}/next`]) {
    const response = await claim(f.broker, nonce); assert.equal(response.status, 400); assert.equal(response.body.error, "COLLECTOR_CLAIM_REQUEST_INVALID");
  }
  assert.equal((await f.broker.getJob(job.id)).status, "queued");
  const lease = (await claim(f.broker)).body.job; assert.equal(lease.id, job.id);
  assert.equal((await f.ledger()).jobs[0].claimRequestId, undefined);
});

test("a malformed persisted nonce receipt fails closed rather than leasing the next job", async t => {
  const f = await fixture(t), job = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  await fs.writeFile(path.join(f.dataDir, "collector", "claims", `${sha(nonce)}.json`), "{}");
  const response = await claim(f.broker, nonce);
  assert.equal(response.status, 503); assert.equal(response.body.error, "COLLECTOR_CLAIM_RECEIPT_INVALID");
  assert.equal((await f.broker.getJob(job.id)).status, "queued");
});

test("a crash gap after nonce reservation cannot turn that nonce into a new lease", async t => {
  const f = await fixture(t), job = await f.broker.submit(jobInput()), nonce = crypto.randomUUID();
  // Model the durable reservation written immediately before the atomic lease receipt.
  await fs.writeFile(path.join(f.dataDir, "collector", "claims", `${sha(nonce)}.json`), JSON.stringify({ version: 1,
    claimRequestId: nonce, workerId: WORKER, jobId: job.id, acceptedAt: job.createdAt }));
  assert.deepEqual((await claim(f.broker, nonce)).body, { job: null });
  assert.equal((await f.broker.getJob(job.id)).status, "queued");
  assert.equal((await claim(f.broker, crypto.randomUUID())).body.job.id, job.id);
});

test("the broker replaces worker-provided schedule proof with its accepted job identity before hashing publication", async t => {
  const f = await fixture(t), input = jobInput({ scheduleOccurrenceId: "rotation_2026-10-20_1", clientRequestId: "rotation_2026-10-20_1" });
  const submitted = await f.broker.submit(input), lease = (await claim(f.broker, crypto.randomUUID())).body.job;
  const bundle = artifacts(lease, input, { schedulingReceipt: { version: 1, scheduleOccurrenceId: "forged_other_slot", jobId: "forged_job", secret: "worker-forged" } });
  assert.equal((await finish(f.broker, lease, bundle)).status, 200);
  const expected = { version: 1, scheduleOccurrenceId: input.payload.scheduleOccurrenceId, jobId: submitted.id,
    workerKey: "manual", trigger: "scheduled", acceptedAt: submitted.createdAt };
  const filename = path.join(f.outputsDir, bundle.runId, "manifest.json"), publishedBytes = await fs.readFile(filename);
  assert.deepEqual(JSON.parse(publishedBytes).schedulingReceipt, expected);
  const ledgerJob = (await f.ledger()).jobs.find(job => job.id === submitted.id);
  assert.equal(ledgerJob.env, undefined); assert.equal(ledgerJob.context, undefined); assert.equal(ledgerJob.payload, undefined);
  assert.equal(ledgerJob.scheduleOccurrenceId, input.payload.scheduleOccurrenceId); assert.equal(ledgerJob.clientRequestId, input.payload.clientRequestId);
  const publishedManifest = ledgerJob.completion.publishedFiles.find(file => file.path === "manifest.json");
  assert.equal(publishedManifest.sha256, sha(publishedBytes)); assert.equal(publishedManifest.size, publishedBytes.length);
  assert.notEqual(publishedManifest.sha256, bundle.files.find(file => file.path === "manifest.json").sha256);
  const restarted = createCollectorBroker(f.options); await restarted.initialize();
  const saved = await restarted.getJob(submitted.id);
  assert.equal(saved.scheduleOccurrenceId, input.payload.scheduleOccurrenceId); assert.deepEqual(saved.manifest.schedulingReceipt, expected);
});

test("unbound jobs cannot publish a forged schedule receipt", async t => {
  const f = await fixture(t), input = jobInput(); await f.broker.submit(input);
  const lease = (await claim(f.broker, crypto.randomUUID())).body.job;
  const bundle = artifacts(lease, input, { schedulingReceipt: { version: 1, scheduleOccurrenceId: "forged_slot" } });
  assert.equal((await finish(f.broker, lease, bundle)).status, 200);
  const published = JSON.parse(await fs.readFile(path.join(f.outputsDir, bundle.runId, "manifest.json"), "utf8"));
  assert.equal(published.schedulingReceipt, undefined);
});

test("schedule provenance is restricted to safe IDs and scheduled submissions", async t => {
  const f = await fixture(t);
  for (const field of ["scheduleOccurrenceId", "clientRequestId"]) {
    for (const value of ["", " unsafe", "../slot", "a/b", "a".repeat(121), 1]) {
      await assert.rejects(f.broker.submit(jobInput({ [field]: value })), { code: "COLLECTOR_INVALID_PAYLOAD" });
    }
  }
  await assert.rejects(f.broker.submit(jobInput({ trigger: "manual", scheduledCollection: false, scheduleOccurrenceId: "rotation_slot" })), { code: "COLLECTOR_INVALID_PAYLOAD" });
  assert.equal((await f.ledger()).jobs.length, 0);
});
