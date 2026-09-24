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

async function failedRecoverySource(broker, overrides = {}) {
  const expected = { keyword: "가평 풀빌라", checkIn: "2026-09-22", checkOut: "2026-10-22", adults: 2,
    searchMode: "keyword", searchIntent: "lodging", searchRegion: "", searchScope: "nationwide",
    collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", detailRankRanges: "1-20",
    bookingRangeDays: 31, bookingRangePlaceLimit: 0, sourceRole: "admin", collectionSource: "admin_search",
    workerKey: "manual", trigger: "manual", scheduledCollection: false };
  const input = jobInput({ payload: expected, env: { ...jobInput().env, ADULTS: "2", SEARCH_MODE: "keyword", SEARCH_INTENT: "lodging",
    SEARCH_REGION: "", SEARCH_SCOPE: "nationwide", BOOKING_RANGE_PLACE_LIMIT: "0", SOURCE_ROLE: "admin", COLLECTION_SOURCE: "admin_search", SCHEDULED_COLLECTION: "0" } });
  const lease = await claimed(broker, input);
  const runId = `gapyeong_manual_${lease.env.COLLECTOR_RUN_TOKEN}_glamping_20260922_200000`;
  const reference = { file: "details/items.json", field: "naver_booking_schedules", placeId: "123", bookingBusinessId: "456", itemCount: 1, originalLength: 45 };
  const bundle = artifacts({ ...expected, outputDir: `/worker/outputs/${runId}`, jobId: lease.id,
    collectorEngine: "current-manual-v2", collectorRunToken: lease.env.COLLECTOR_RUN_TOKEN,
    collectionProfileFlags: { collectBookingStock: true },
    detailJsonFiles: [{ ...reference }, { ...reference }],
    counts: { ...artifacts().manifest.counts, naverBookingStockEligible: 2, detailJsonFiles: 2 }, ...overrides });
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle, runId)).body.error, "COLLECTOR_DUPLICATE_PATH");
  const failed = await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_UPLOAD_FAILED",
    failurePhase: "final_validation", brokerErrorCode: "COLLECTOR_DUPLICATE_PATH" });
  assert.equal(failed.status, 200);
  return { lease, runId, bundle, input, recoveryInput: { manifestSha256: sha(bundle.contents["manifest.json"]), expected } };
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

test("schedule pause withdraws only its queued job and preserves active lease and unrelated queue", () => fixture(async ({ broker, dataDir }) => {
  const active = await claimed(broker);
  const withdrawn = await broker.submit(jobInput());
  const remaining = await broker.submit(jobInput());
  const receipt = await broker.cancelQueued(withdrawn.id, "COLLECTOR_SCHEDULE_PAUSED");
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.errorCode, "COLLECTOR_SCHEDULE_PAUSED");
  assert.equal((await broker.getJob(active.id)).status, "leased");
  assert.equal((await broker.getJob(remaining.id)).status, "queued");
  assert.equal((await broker.status()).activeJobId, active.id);
  assert.equal((await broker.status()).halted, false);
  assert.equal((await broker.status()).queued, 1);
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${active.id}/heartbeat`, identity(active))).body.cancelled, false);
  assert.equal((await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job, null);
  const ledger = JSON.parse(await fs.readFile(path.join(dataDir, "collector", "jobs.json"), "utf8"));
  const stored = ledger.jobs.find(job => job.id === withdrawn.id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.env, undefined);
  assert.equal(stored.context, undefined);
  assert.equal(stored.payload, undefined);
  assert.equal((await broker.cancelQueued(withdrawn.id, "SECOND_PAUSE")).errorCode, "COLLECTOR_SCHEDULE_PAUSED");
  const bundle = artifacts();
  await uploadArtifacts(broker, active, bundle);
  assert.equal((await finish(broker, active, bundle)).status, 200);
  const next = (await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 })).body.job;
  assert.equal(next.id, remaining.id);
}));

test("a claim winning the pause race remains leased and may complete normally", () => fixture(async ({ broker }) => {
  const lease = await claimed(broker);
  const preserved = await broker.cancelQueued(lease.id, "COLLECTOR_SCHEDULE_PAUSED");
  assert.equal(preserved.status, "leased");
  assert.equal(preserved.errorCode, undefined);
  assert.equal((await broker.status()).activeJobId, lease.id);
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/heartbeat`, identity(lease))).body.cancelled, false);
  const bundle = artifacts();
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle)).status, 200);
  assert.equal((await broker.cancelQueued(lease.id)).status, "completed");
  assert.equal((await broker.getJob(lease.id)).runId, RUN);
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

test("role namespaces isolate credentials and allow scheduled-worker immediate and timed jobs", () => fixture(async ({ options, dataDir }) => {
  const manual = createCollectorBroker({ ...options, workerKey: "manual" });
  const scheduled = createCollectorBroker({ ...options, brokerDir: path.join(dataDir, "collector-scheduled"), workerKey: "scheduled", token: `${TOKEN}-other` });
  await Promise.all([manual.initialize(), scheduled.initialize()]);
  const manualInput = jobInput({ env: { ...jobInput().env, SCHEDULED_COLLECTION: "0" }, payload: { workerKey: "manual", trigger: "manual" } });
  const manualJob = await manual.submit(manualInput);
  await assert.rejects(manual.submit(jobInput({ payload: { workerKey: "scheduled", trigger: "scheduled" } })), { code: "COLLECTOR_WRONG_WORKER" });
  await assert.rejects(manual.submit(jobInput({ payload: { workerKey: "manual", trigger: "scheduled" } })), { code: "COLLECTOR_WRONG_WORKER" });
  await scheduled.submit({ ...manualInput, payload: { workerKey: "scheduled", trigger: "manual" } });
  await scheduled.submit(jobInput({ payload: { workerKey: "scheduled", trigger: "scheduled" } }));
  assert.equal((await manual.status()).queued, 1);
  assert.equal((await scheduled.status()).queued, 2);
  assert.equal((await request(scheduled, "POST", "/api/collector-worker/claim", {})).handled, false);
  assert.equal((await request(scheduled, "POST", "/api/collector-worker-scheduled/claim", { workerId: WORKER, protocolVersion: 1 })).status, 401);
  const lease = (await request(manual, "POST", "/api/collector-worker/claim", { workerId: WORKER, workerKey: "manual", protocolVersion: 1 })).body.job;
  assert.equal(lease.id, manualJob.id);
  assert.equal(lease.env.COLLECTOR_JOB_ID, manualJob.id);
  assert.match(lease.env.COLLECTOR_RUN_TOKEN, /^[a-p]{24}$/);
  assert.equal(lease.env.COLLECTOR_ENGINE, "current-manual-v2");
  const claimedScheduled = await request(scheduled, "POST", "/api/collector-worker-scheduled/claim", { workerId: WORKER, workerKey: "scheduled", protocolVersion: 1 }, { authorization: `Bearer ${TOKEN}-other` });
  assert.equal(claimedScheduled.body.job.trigger, "manual");
  assert.equal(claimedScheduled.body.job.env.SCHEDULED_COLLECTION, "0");
  assert.equal(claimedScheduled.body.job.env.COLLECTOR_ENGINE, "archive-keyword-adapted-v2");
  assert.notEqual(claimedScheduled.body.job.env.COLLECTOR_RUN_TOKEN, lease.env.COLLECTOR_RUN_TOKEN);
  assert.equal((await manual.status()).activeJobId, manualJob.id);
}));

test("provider stop callback runs outside lock and can cancel other active lanes without releasing their lease", () => fixture(async ({ options, dataDir }) => {
  let callbacks = 0;
  const other = createCollectorBroker({ ...options, brokerDir: path.join(dataDir, "other") });
  await other.initialize();
  const otherLease = await claimed(other);
  let provider;
  provider = createCollectorBroker({ ...options, brokerDir: path.join(dataDir, "source"), onProviderBlocked: async event => {
    callbacks++;
    assert.equal(event.code, "COLLECTOR_PROVIDER_BLOCKED");
    assert.equal((await provider.status()).halted, true);
    await other.halt(event.code, { cancelActive: true, cancelQueued: true });
  } });
  await provider.initialize();
  const lease = await claimed(provider);
  const route = `/api/collector-worker/jobs/${lease.id}/heartbeat`;
  assert.equal((await request(provider, "POST", route, { ...identity(lease), providerBlocked: true })).status, 200);
  assert.equal((await request(provider, "POST", route, { ...identity(lease), providerBlocked: true })).status, 200);
  assert.equal(callbacks, 1);
  assert.equal((await provider.getJob(lease.id)).status, "leased");
  assert.equal((await other.getJob(otherLease.id)).status, "cancelled");
  assert.equal((await other.status()).activeJobId, otherLease.id);
  assert.equal((await request(other, "POST", `/api/collector-worker/jobs/${otherLease.id}/heartbeat`, identity(otherLease))).body.cancelled, true);
  assert.equal((await request(other, "POST", `/api/collector-worker/jobs/${otherLease.id}/fail`, { ...identity(otherLease), code: "COLLECTOR_CANCELLED" })).status, 200);
  assert.equal((await other.status()).errorCode, "COLLECTOR_PROVIDER_BLOCKED");
  assert.equal((await other.status()).activeJobId, null);
}));

test("a failed cross-lane notification retries on the failure receipt and retains provider protection", () => fixture(async ({ options, dataDir }) => {
  let attempts = 0;
  const broker = createCollectorBroker({ ...options, brokerDir: path.join(dataDir, "notify"), onProviderBlocked: async () => {
    if (++attempts === 1) throw new Error("temporary callback failure");
  } });
  await broker.initialize();
  const lease = await claimed(broker);
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/heartbeat`, { ...identity(lease), providerBlocked: true })).status, 500);
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_HEARTBEAT_FAILED" })).status, 200);
  assert.equal(attempts, 2);
  assert.equal((await broker.status()).errorCode, "COLLECTOR_PROVIDER_BLOCKED");
}));

test("role receipt binds job identity and alphabetic run token before publication", () => fixture(async ({ options }) => {
  const broker = createCollectorBroker({ ...options, workerKey: "scheduled", apiBasePath: "/api/collector-worker" });
  await broker.initialize();
  const lease = await claimed(broker, jobInput({ payload: { workerKey: "scheduled", trigger: "scheduled" } }));
  const runId = `gapyeong_scheduled_${lease.env.COLLECTOR_RUN_TOKEN}_glamping_20260922_200000`;
  const bundle = artifacts({ outputDir: `/worker/outputs/${runId}`, workerKey: "scheduled", trigger: "scheduled", jobId: "another-job", collectorEngine: "archive-keyword-adapted-v2" });
  await uploadArtifacts(broker, lease, bundle);
  assert.equal((await finish(broker, lease, bundle, runId)).body.error, "COLLECTOR_SCOPE_MISMATCH");
  assert.equal((await broker.getJob(lease.id)).status, "leased");
}));

test("claim atomically expires scheduled queued jobs at deadline while a leased job may continue", () => fixture(async ({ broker, advance }) => {
  const deadline = Date.parse("2026-09-22T11:00:00Z") + 500;
  const expired = await broker.submit({ ...jobInput(), queueDeadline: deadline });
  advance(500);
  const idle = await request(broker, "POST", "/api/collector-worker/claim", { workerId: WORKER, protocolVersion: 1 });
  assert.equal(idle.body.job, null);
  assert.equal((await broker.getJob(expired.id)).errorCode, "COLLECTOR_QUEUE_DEADLINE");
  assert.equal((await broker.status()).halted, false);
  const live = await claimed(broker, { ...jobInput(), queueDeadline: deadline + 500 });
  advance(1000);
  assert.equal((await broker.getJob(live.id)).status, "leased");
  assert.equal((await request(broker, "POST", `/api/collector-worker/jobs/${live.id}/heartbeat`, identity(live))).body.cancelled, false);
}));

test("explicit recovery publishes verified files once while retaining the original failure and staging bytes", () => fixture(async ({ broker, dataDir, outputsDir, options, advance }) => {
  const source = await failedRecoverySource(broker);
  const originalJob = await broker.getJob(source.lease.id);
  const originalHalt = await broker.status();
  const recovered = await broker.recover(source.lease.id, source.recoveryInput);
  assert.equal(recovered.runId, source.runId);
  assert.equal(recovered.collectionQuality.status, "complete");
  assert.equal(recovered.manifest.detailJsonFiles.length, 1);
  assert.equal(recovered.manifest.counts.detailJsonFiles, 1);
  assert.equal(recovered.recovery.duplicateReferences, 1);
  assert.equal(recovered.recovery.originalManifestSha256, source.recoveryInput.manifestSha256);
  assert.equal(recovered.outputDir, path.join(outputsDir, source.runId));
  assert.deepEqual(recovered.manifest.fileRoles, source.bundle.manifest.fileRoles);
  const staging = path.join(dataDir, "collector", "staging", source.lease.id);
  for (const [name, original] of Object.entries(source.bundle.contents)) {
    assert.deepEqual(await fs.readFile(path.join(staging, name)), original);
    if (name !== "manifest.json") assert.equal(sha(await fs.readFile(path.join(recovered.outputDir, name))), sha(original));
  }
  const publishedManifest = await fs.readFile(path.join(recovered.outputDir, "manifest.json"));
  assert.deepEqual(JSON.parse(publishedManifest), recovered.manifest);
  const current = await broker.getJob(source.lease.id);
  assert.deepEqual(Object.fromEntries(Object.entries(current).filter(([key]) => key !== "recovery")), originalJob);
  assert.deepEqual(await broker.status(), originalHalt);
  assert.equal(current.status, "failed"); assert.equal(current.errorCode, "COLLECTOR_UPLOAD_FAILED");
  const receipt = JSON.parse(await fs.readFile(path.join(dataDir, "collector", "recovery", source.lease.id, "source.json")));
  assert.equal(receipt.originalStatus, "failed"); assert.equal(receipt.originalFinishedAt, originalJob.finishedAt);
  assert.equal(receipt.manifestSha256, source.recoveryInput.manifestSha256);
  assert.deepEqual(receipt.files.map(file => [file.path, file.sha256]).sort(), source.bundle.files.map(file => [file.path, file.sha256]).sort());
  advance(1000);
  assert.deepEqual(await broker.recover(source.lease.id, source.recoveryInput), recovered);
  const restarted = createCollectorBroker(options);
  await restarted.initialize();
  assert.deepEqual(await restarted.recover(source.lease.id, source.recoveryInput), recovered);
  assert.deepEqual(await fs.readFile(path.join(recovered.outputDir, "manifest.json")), publishedManifest);
  assert.deepEqual(await fs.readdir(outputsDir), [source.runId]);
  assert.equal((await restarted.getJob(source.lease.id)).status, "failed");
  assert.equal((await restarted.status()).halted, true);
}, { workerKey: "manual" }));

test("recovery refuses a wrong source hash or changed uploaded content before publication", async () => {
  for (const variant of ["manifest-hash", "content-hash"]) {
    await fixture(async ({ broker, dataDir, outputsDir }) => {
      const source = await failedRecoverySource(broker);
      const before = await broker.getJob(source.lease.id);
      if (variant === "manifest-hash") source.recoveryInput.manifestSha256 = sha("another manifest");
      else await fs.writeFile(path.join(dataDir, "collector", "staging", source.lease.id, "details", "items.json"),
        Buffer.alloc(source.bundle.contents["details/items.json"].length, "x"));
      await assert.rejects(broker.recover(source.lease.id, source.recoveryInput), {
        code: variant === "manifest-hash" ? "COLLECTOR_RECOVERY_SOURCE_MISMATCH" : "COLLECTOR_FILE_HASH_MISMATCH"
      });
      assert.deepEqual(await fs.readdir(outputsDir), []);
      assert.deepEqual(await broker.getJob(source.lease.id), before);
    }, { workerKey: "manual" });
  }
});

test("recovery refuses blocked or partial collection quality even when file hashes match", async () => {
  for (const overrides of [
    { naverBookingBlockedStatus: 429 },
    { counts: { ...artifacts().manifest.counts, naverBookingStockEligible: 2, detailJsonFiles: 2, naverScheduleSucceeded: 61, naverScheduleFailed: 1 } }
  ]) {
    await fixture(async ({ broker, outputsDir }) => {
      const source = await failedRecoverySource(broker, overrides);
      await assert.rejects(broker.recover(source.lease.id, source.recoveryInput), { code: "COLLECTOR_RECOVERY_QUALITY_HOLD" });
      assert.deepEqual(await fs.readdir(outputsDir), []);
      assert.equal((await broker.getJob(source.lease.id)).recovery, undefined);
    }, { workerKey: "manual" });
  }
});

test("recovery requires the full reviewed scope and rejects a mismatched collection interval", async () => {
  for (const variant of ["missing", "mismatch"]) {
    await fixture(async ({ broker, outputsDir }) => {
      const source = await failedRecoverySource(broker);
      if (variant === "missing") delete source.recoveryInput.expected.adults;
      else source.recoveryInput.expected.bookingRangeDays = 7;
      await assert.rejects(broker.recover(source.lease.id, source.recoveryInput), {
        code: variant === "missing" ? "COLLECTOR_RECOVERY_SCOPE_REQUIRED" : "COLLECTOR_SCOPE_MISMATCH"
      });
      assert.deepEqual(await fs.readdir(outputsDir), []);
    }, { workerKey: "manual" });
  }
});

test("conflicting duplicate detail descriptors are never silently normalized", () => fixture(async ({ broker, outputsDir }) => {
  const source = await failedRecoverySource(broker, { detailJsonFiles: [
    { file: "details/items.json", placeId: "123", itemCount: 1 },
    { file: "details/items.json", placeId: "123", itemCount: 2 }
  ] });
  await assert.rejects(broker.recover(source.lease.id, source.recoveryInput), { code: "COLLECTOR_RECOVERY_REFERENCE_CONFLICT" });
  assert.deepEqual(await fs.readdir(outputsDir), []);
}, { workerKey: "manual" }));

test("recovery does not run alongside an active job or clear provider protection", async () => {
  for (const variant of ["active", "provider-protection"]) {
    await fixture(async ({ broker, outputsDir }) => {
      const source = await failedRecoverySource(broker);
      let active;
      if (variant === "active") {
        await broker.resetHalt();
        active = await claimed(broker, source.input);
      } else await broker.halt("COLLECTOR_PROVIDER_BLOCKED");
      await assert.rejects(broker.recover(source.lease.id, source.recoveryInput), {
        code: variant === "active" ? "COLLECTOR_RECOVERY_BUSY" : "COLLECTOR_RECOVERY_NOT_ELIGIBLE"
      });
      assert.deepEqual(await fs.readdir(outputsDir), []);
      if (active) assert.equal((await broker.status()).activeJobId, active.id);
      else assert.equal((await broker.status()).errorCode, "COLLECTOR_PROVIDER_BLOCKED");
    }, { workerKey: "manual" });
  }
});

test("fail diagnostics retain only allowed phase and broker code across restart", async () => {
  for (const valid of [true, false]) {
    await fixture(async ({ broker, options, dataDir }) => {
      const lease = await claimed(broker);
      const secret = "DO_NOT_STORE_FAILURE_SECRET";
      const response = await request(broker, "POST", `/api/collector-worker/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_UPLOAD_FAILED",
        failurePhase: valid ? "final_validation" : `${secret}/private/path`,
        brokerErrorCode: valid ? "COLLECTOR_DUPLICATE_PATH" : `COLLECTOR_${secret}`, raw: secret });
      assert.equal(response.status, 200);
      const restarted = createCollectorBroker(options);
      await restarted.initialize();
      const receipt = await restarted.getJob(lease.id);
      assert.equal(receipt.failurePhase, valid ? "final_validation" : undefined);
      assert.equal(receipt.brokerErrorCode, valid ? "COLLECTOR_DUPLICATE_PATH" : undefined);
      assert.equal((await fs.readFile(path.join(dataDir, "collector", "jobs.json"), "utf8")).includes(secret), false);
    });
  }
});

(async () => {
  for (const { name, operation } of tests) {
    await operation();
    console.log(`PASS ${name}`);
  }
  console.log(`collector broker: ${tests.length} tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
