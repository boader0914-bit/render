"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createCollectorBroker, LEASE_MS, MAX_FILE_BYTES } = require("./collector_broker.cjs");

const TOKEN = "test-only-collector-token-32-characters-long";
const WORKER = "staydatalab-collector";
const RUN = "gapyeong_glamping_20260922_200000";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const tests = [];
const test = (name, operation) => tests.push({ name, operation });

async function fixture(operation, extra = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "collector-broker-test-"));
  const dataDir = path.join(temporary, "data");
  const outputsDir = path.join(dataDir, "outputs");
  let now = Date.parse("2026-09-22T11:00:00Z");
  const progress = [];
  const options = { dataDir, outputsDir, token: TOKEN, workerId: WORKER, now: () => now, onProgress: event => progress.push(event), ...extra };
  const broker = createCollectorBroker(options);
  try {
    await broker.initialize();
    await operation({ broker, options, dataDir, outputsDir, progress, advance: milliseconds => { now += milliseconds; } });
  } finally {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("collector-broker-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
async function request(broker, method, route, body, extraHeaders = {}) {
  const binary = Buffer.isBuffer(body);
  const buffer = binary ? body : Buffer.from(JSON.stringify(body ?? {}));
  const req = Readable.from([buffer]);
  req.method = method;
  req.url = route;
  req.headers = { authorization: `Bearer ${TOKEN}`, "content-length": String(buffer.length), "content-type": binary ? "application/octet-stream" : "application/json", ...extraHeaders };
  let status;
  let response;
  const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(value) { response = JSON.parse(value); } };
  const handled = await broker.handleHttp(req, res, new URL(route, "http://local.test"));
  return { handled, status, body: response };
}
const identity = lease => ({ workerId: WORKER, leaseToken: lease.leaseToken });
function jobInput(overrides = {}) {
  return { keyword: "가평 풀빌라", env: { CHECK_IN: "2026-09-22", CHECK_OUT: "2026-10-22", COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail",
    DETAIL_RANK_RANGES: "1-20", BOOKING_RANGE_DAYS: "31", PRODUCT_MODE: "all", SCHEDULED_COLLECTION: "1" },
  payload: { keyword: "가평 풀빌라", scheduledCollection: true }, context: { historicalBookingBusinesses: [{ placeId: "123", businessId: "456" }] }, ...overrides };
}
async function claimed(broker, input) {
  const job = await broker.submit(input || jobInput());
  const response = await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.body.job.id, job.id);
  return response.body.job;
}
function artifacts(overrides = {}) {
  const manifest = { keyword: "가평 풀빌라", outputDir: `/worker/outputs/${RUN}`, collectedAt: "2026-09-22T11:01:00Z", checkIn: "2026-09-22", checkOut: "2026-10-22",
    collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-20", bookingRangeDays: 31, productMode: "all", scheduledCollection: true, workerCollection: true,
    naverAttemptedQueries: [{ status: 200 }], fileRoles: { overall: "rows.csv" }, files: ["rows.csv"], detailJsonFiles: [{ file: "details/items.json", itemCount: 1 }],
    counts: { naverOverall: 2, naverBookingStockChecked: 2, naverBookingStockSucceeded: 2, naverOtaObservationChecked: 2, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 62, naverScheduleSucceeded: 62, naverScheduleFailed: 0, naverScheduleBlocked: 0 }, ...overrides };
  const contents = { "manifest.json": Buffer.from(JSON.stringify(manifest)), "rows.csv": Buffer.from("name,detail\nfixture,@json-file:details/items.json\n"),
    "details/items.json": Buffer.from('[{"date":"2026-09-22","stock":1}]') };
  return { manifest, contents, files: Object.entries(contents).map(([filename, value]) => ({ path: filename, size: value.length, sha256: sha(value) })) };
}
async function uploadOne(broker, lease, filename, buffer, headers = {}) {
  return request(broker, "PUT", `/api/collector-worker/jobs/${lease.id}/files?path=${encodeURIComponent(filename)}`, buffer,
    { "x-collector-worker": WORKER, "x-collector-lease": lease.leaseToken, "x-content-sha256": sha(buffer), ...headers });
}
async function uploadArtifacts(broker, lease, bundle) {
  for (const [name, buffer] of Object.entries(bundle.contents)) {
    const response = await uploadOne(broker, lease, name, buffer);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
  }
}
async function finish(broker, lease, bundle, runId = RUN) {
  return request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/complete`, { ...identity(lease), runId, files: bundle.files });
}

test("disabled and invalid authentication do not expose work", () => fixture(async ({ broker, options }) => {
  const disabled = createCollectorBroker({ ...options, token: "short" });
  assert.equal((await request(disabled, "POST", "/api/collector-worker/claim", {})).status, 404);
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", {}, { authorization: "Bearer incorrect" })).status, 401);
  assert.equal((await request(broker, "GET", "/api/unrelated", {})).handled, false);
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: "another-worker", protocolVersion: 1 })).status, 403);
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 2 })).status, 400);
}));

test("secrets, paths and unsupported context are not submitted or disclosed", () => fixture(async ({ broker }) => {
  await assert.rejects(broker.submit(jobInput({ env: { NODE_OPTIONS: "unsafe" } })), { code: "COLLECTOR_INVALID_ENV" });
  await assert.rejects(broker.submit(jobInput({ context: { historyPath: "/secret" } })), { code: "COLLECTOR_INVALID_CONTEXT" });
  const job = await broker.submit(jobInput({ payload: { secret: "never-store", ...jobInput().payload } }));
  assert.equal(job.status, "queued");
  assert.equal(job.env, undefined);
  assert.equal(job.context, undefined);
  assert.equal((await broker.getJob(job.id)).leaseToken, undefined);
}));

test("concurrent claims lease only one job, and progress accepts only fixed stages", () => fixture(async ({ broker, progress }) => {
  await broker.submit(jobInput());
  await broker.submit(jobInput());
  const responses = await Promise.all([1, 2].map(() => request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })));
  assert.equal(responses.filter(response => response.body.job).length, 1);
  const lease = responses.find(response => response.body.job).body.job;
  assert.equal(lease.leaseMs, LEASE_MS);
  const route = `/api/collector-worker/jobs/${lease.id}/heartbeat`;
  assert.equal((await request(broker, "POST", route, { ...identity(lease), stage: "inventory" })).status, 200);
  assert.deepEqual(progress, [{ id: lease.id, stage: "inventory" }]);
  assert.equal((await request(broker, "POST", route, { ...identity(lease), stage: "https://secret" })).status, 400);
  assert.equal((await request(broker, "POST", route, { ...identity(lease), leaseToken: "wrong" })).status, 409);
}));

test("restart interrupts pending work and persists the halt without an automatic claim", () => fixture(async ({ broker, options }) => {
  const lease = await claimed(broker);
  const queued = await broker.submit(jobInput());
  const restarted = createCollectorBroker(options);
  await restarted.initialize();
  assert.equal((await restarted.getJob(lease.id)).status, "interrupted");
  assert.equal((await restarted.getJob(queued.id)).status, "interrupted");
  assert.equal((await restarted.status()).errorCode, "COLLECTOR_RESTART_INTERRUPTED");
  assert.equal((await request(restarted, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job, null);
  await assert.rejects(restarted.submit(jobInput()), { code: "COLLECTOR_RESTART_INTERRUPTED" });
  const again = createCollectorBroker(options);
  await again.initialize();
  assert.equal((await again.status()).halted, true);
  await again.resetHalt();
  assert.equal((await again.status()).halted, false);
}));

test("lease expiration halts further work and rejects late heartbeat", () => fixture(async ({ broker, advance }) => {
  const lease = await claimed(broker);
  advance(LEASE_MS + 1);
  assert.equal((await broker.getJob(lease.id)).errorCode, "COLLECTOR_LEASE_EXPIRED");
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/heartbeat`, identity(lease))).status, 409);
  assert.equal((await broker.status()).halted, true);
}));

test("cancellation keeps lease exclusivity until the worker acknowledges stopping", () => fixture(async ({ broker }) => {
  const lease = await claimed(broker);
  const next = await broker.submit(jobInput());
  assert.equal((await broker.cancel(lease.id)).status, "cancelled");
  assert.deepEqual((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/heartbeat`, identity(lease))).body, { cancelled: true });
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job, null);
  await assert.rejects(broker.resetHalt(), { code: "COLLECTOR_PENDING_JOBS" });
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_CANCELLED" })).status, 200);
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job, null);
  assert.equal((await broker.status()).errorCode, "COLLECTOR_CANCELLED");
  await broker.cancel(next.id);
  await broker.resetHalt();
  assert.equal((await broker.status()).halted, false);
}));

test("path traversal, symlinks, case collisions and oversize uploads are rejected", () => fixture(async ({ broker, dataDir, outputsDir }) => {
  const lease = await claimed(broker);
  for (const name of ["../escape.json", "/escape.json", "details/../escape.json", "details\\escape.json", "con.json", "detail./x.json", "x.exe"]) {
    assert.equal((await uploadOne(broker, lease, name, Buffer.from("x"))).status, 400, name);
  }
  assert.equal((await uploadOne(broker, lease, "a.json", Buffer.from("x"), { "content-length": String(MAX_FILE_BYTES + 1) })).status, 413);
  assert.equal((await uploadOne(broker, lease, "A.json", Buffer.from("x"))).status, 200);
  assert.equal((await uploadOne(broker, lease, "a.json", Buffer.from("x"))).status, 400);
  assert.equal((await uploadOne(broker, lease, "Details/a.json", Buffer.from("x"))).status, 200);
  assert.equal((await uploadOne(broker, lease, "details/b.json", Buffer.from("x"))).status, 400);
  const linked = path.join(dataDir, "collector", "staging", lease.id, "linked");
  await fs.symlink(outputsDir, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await uploadOne(broker, lease, "linked/x.json", Buffer.from("x"))).status, 409);
  assert.deepEqual(await fs.readdir(outputsDir), []);
}));

test("uploaded bytes must match both advertised length and hash", () => fixture(async ({ broker, dataDir }) => {
  const lease = await claimed(broker);
  assert.equal((await uploadOne(broker, lease, "wrong.json", Buffer.from("abc"), { "x-content-sha256": sha("different") })).status, 400);
  assert.equal((await uploadOne(broker, lease, "short.json", Buffer.from("abc"), { "content-length": "4" })).status, 400);
  assert.equal((await uploadOne(broker, lease, "long.json", Buffer.from("abc"), { "content-length": "2" })).status, 400);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "collector", "staging", lease.id)), []);
}));

test("complete validates scope and the exact manifest reference set", () => fixture(async ({ broker }) => {
  const lease = await claimed(broker);
  const bundle = artifacts({ keyword: "다른 지역" });
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).body.error, "COLLECTOR_SCOPE_MISMATCH");
  assert.equal((await finish(broker, lease, { files: bundle.files.slice(1) })).body.error, "COLLECTOR_FILE_SET_MISMATCH");
}));

test("worker provenance and run date are validated before publishing", async () => {
  for (const [override, runId, expected] of [
    [{ workerCollection: false }, RUN, "COLLECTOR_WORKER_RECEIPT_REQUIRED"],
    [{ outputDir: "/worker/outputs/gapyeong_glamping_20260923_200000" }, "gapyeong_glamping_20260923_200000", "COLLECTOR_RUN_ID_MISMATCH"],
  ]) {
    await fixture(async ({ broker }) => {
      const lease = await claimed(broker);
      const bundle = artifacts(override);
      await uploadArtifacts(broker, lease, bundle);
      assert.equal((await finish(broker, lease, bundle, runId)).body.error, expected);
    });
  }
});

test("unreferenced files, manifest traversal and missing detail files are rejected", async () => {
  for (const override of [{ files: ["rows.csv", "missing.csv"] }, { detailJsonFiles: [{ file: "../escape.json" }] }, { detailJsonFiles: [] }]) {
    await fixture(async ({ broker }) => {
      const lease = await claimed(broker);
      const bundle = artifacts(override);
      await uploadArtifacts(broker, lease, bundle);
      assert.equal((await finish(broker, lease, bundle)).status, 400);
    });
  }
});

test("partial results are preserved, and completion retry after a lost ACK is idempotent", () => fixture(async ({ broker, outputsDir, options }) => {
  const lease = await claimed(broker);
  const bundle = artifacts();
  bundle.manifest.counts.naverScheduleSucceeded = 61;
  bundle.manifest.counts.naverScheduleFailed = 1;
  bundle.contents["manifest.json"] = Buffer.from(JSON.stringify(bundle.manifest));
  bundle.files.find(file => file.path === "manifest.json").size = bundle.contents["manifest.json"].length;
  bundle.files.find(file => file.path === "manifest.json").sha256 = sha(bundle.contents["manifest.json"]);
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  const job = await broker.getJob(lease.id);
  assert.equal(job.status, "completed");
  assert.equal(job.collectionQuality.status, "partial");
  assert.equal(job.outputDir, path.join(outputsDir, RUN));
  assert.equal(job.manifest.outputDir, job.outputDir);
  assert.equal(JSON.parse(await fs.readFile(path.join(job.outputDir, "manifest.json"))).outputDir, job.outputDir);
  assert.equal(job.leaseHash, undefined);
  const restarted = createCollectorBroker(options);
  await restarted.initialize();
  assert.equal((await finish(restarted, lease, bundle)).status, 200);
  const changed = bundle.files.map(file => ({ ...file }));
  changed[0].sha256 = sha("different");
  assert.equal((await finish(restarted, lease, { files: changed })).status, 409);
}));

test("provider-blocked results remain readable and durably stop the next claim", () => fixture(async ({ broker, options }) => {
  const lease = await claimed(broker);
  const bundle = artifacts({ naverBookingBlockedStatus: 429 });
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  assert.equal((await broker.getJob(lease.id)).collectionQuality.status, "blocked");
  assert.equal((await broker.status()).errorCode, "COLLECTOR_PROVIDER_BLOCKED");
  const restarted = createCollectorBroker(options);
  await restarted.initialize();
  assert.equal((await restarted.status()).halted, true);
}));

test("existing output directories are never overwritten", () => fixture(async ({ broker, outputsDir }) => {
  const lease = await claimed(broker);
  const bundle = artifacts();
  await uploadArtifacts(broker, lease, bundle);
  await fs.mkdir(path.join(outputsDir, RUN));
  await fs.writeFile(path.join(outputsDir, RUN, "existing.json"), "preserve");
  assert.equal((await finish(broker, lease, bundle)).body.error, "COLLECTOR_OUTPUT_EXISTS");
  assert.equal(await fs.readFile(path.join(outputsDir, RUN, "existing.json"), "utf8"), "preserve");
}));

test("fail receipts accept only code strings and cannot expose raw error text", () => fixture(async ({ broker }) => {
  const lease = await claimed(broker);
  const result = await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/fail`, { ...identity(lease), code: "https://secret?token=123" });
  assert.equal(result.status, 200);
  assert.equal((await broker.getJob(lease.id)).errorCode, "COLLECTOR_JOB_FAILED");
  assert.equal((await broker.status()).errorCode, "COLLECTOR_JOB_FAILED");
}));

test("an early failure manifest alone is preserved and halts collection", () => fixture(async ({ broker }) => {
  const lease = await claimed(broker);
  const bundle = artifacts({ collectionFailed: true, files: [], fileRoles: {}, detailJsonFiles: [] });
  bundle.contents = { "manifest.json": Buffer.from(JSON.stringify(bundle.manifest)) };
  bundle.files = Object.entries(bundle.contents).map(([filename, value]) => ({ path: filename, size: value.length, sha256: sha(value) }));
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  assert.equal((await broker.getJob(lease.id)).manifest.collectionFailed, true);
  assert.equal((await broker.status()).errorCode, "COLLECTOR_CRAWL_FAILED");
}));

test("idle claim polls update presence without rewriting the ledger every time", () => fixture(async ({ broker, dataDir, advance }) => {
  const filename = path.join(dataDir, "collector", "jobs.json");
  const before = await fs.readFile(filename, "utf8");
  for (let index = 0; index < 11; index++) {
    advance(5_000);
    assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job, null);
  }
  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.ok((await broker.status()).workerLastSeenAt);
  advance(5_001);
  await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 });
  assert.notEqual(await fs.readFile(filename, "utf8"), before);
}));

test("terminal inputs are discarded and older receipts remain readable outside the bounded ledger", () => fixture(async ({ broker, dataDir }) => {
  let first;
  for (let index = 0; index < 202; index++) {
    const job = await broker.submit(jobInput());
    first ||= job;
    await broker.cancel(job.id);
  }
  const ledger = JSON.parse(await fs.readFile(path.join(dataDir, "collector", "jobs.json"), "utf8"));
  assert.equal(ledger.jobs.length, 200);
  assert.ok(ledger.jobs.every(job => job.env === undefined && job.context === undefined && job.payload === undefined));
  assert.equal((await broker.getJob(first.id)).status, "cancelled");
  const receipt = JSON.parse(await fs.readFile(path.join(dataDir, "collector", "receipts", `${first.id}.json`), "utf8"));
  assert.equal(receipt.env, undefined);
  assert.equal(receipt.context, undefined);
}));

test("restart reconciles an already-published commit receipt without running it again", () => fixture(async ({ broker, dataDir, options }) => {
  const lease = await claimed(broker);
  const bundle = artifacts();
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  const filename = path.join(dataDir, "collector", "jobs.json");
  const ledger = JSON.parse(await fs.readFile(filename, "utf8"));
  ledger.jobs[0].status = "committing";
  delete ledger.jobs[0].leaseReleasedAt;
  delete ledger.jobs[0].manifest;
  await fs.writeFile(filename, JSON.stringify(ledger));
  const restarted = createCollectorBroker(options);
  await restarted.initialize();
  assert.equal((await restarted.getJob(lease.id)).status, "completed");
  assert.equal((await restarted.status()).halted, true);
  assert.equal((await finish(restarted, lease, bundle)).status, 200);
}));

(async () => {
  for (const { name, operation } of tests) {
    await operation();
    console.log(`PASS ${name}`);
  }
  console.log(`collector broker: ${tests.length} tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
