"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createCollectorBroker, LEASE_MS } = require("./collector_broker.cjs");

const TOKEN = "test-only-terminal-status-token-32-characters";
const WORKER = "terminal-fixture-worker";
const BASE = "/api/collector-worker";
const RUN = "gapyeong_glamping_20261025_110000";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const identity = lease => ({ workerId: WORKER, leaseToken: lease.leaseToken });
const jobInput = () => ({ keyword: "가평 풀빌라", env: { CHECK_IN: "2026-10-25", CHECK_OUT: "2026-11-24",
  COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail", DETAIL_RANK_RANGES: "1-20",
  BOOKING_RANGE_DAYS: "31", PRODUCT_MODE: "all", SCHEDULED_COLLECTION: "1" },
  payload: { keyword: "가평 풀빌라", scheduledCollection: true }, context: { historicalBookingBusinesses: [] } });

async function fixture(t, extra = {}, initialize = true) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "collector-terminal-status-"));
  const dataDir = path.join(temporary, "data"), outputsDir = path.join(dataDir, "outputs");
  let now = Date.parse("2026-10-25T02:00:00Z");
  const options = { dataDir, outputsDir, token: TOKEN, workerId: WORKER, now: () => now, ...extra };
  const broker = createCollectorBroker(options);
  if (initialize) await broker.initialize();
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("collector-terminal-status-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { broker, options, dataDir, outputsDir, temporary, advance: ms => { now += ms; },
    ledgerFile: path.join(dataDir, "collector", "jobs.json"),
    ledger: async () => JSON.parse(await fs.readFile(path.join(dataDir, "collector", "jobs.json"), "utf8")) };
}
async function request(broker, route, body = {}, { method = "POST", headers = {}, loseReply = false } = {}) {
  const binary = Buffer.isBuffer(body), buffer = binary ? body : Buffer.from(JSON.stringify(body));
  const req = Readable.from([buffer]);
  Object.assign(req, { method, url: route, headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(buffer.length),
    "content-type": binary ? "application/octet-stream" : "application/json", ...headers } });
  let status, response;
  const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(value) {
    if (loseReply) throw new Error("fixture ACK lost after commit");
    response = JSON.parse(value);
  } };
  assert.equal(await broker.handleHttp(req, res, new URL(route, "http://fixture.test")), true);
  return { status, body: response };
}
async function claimed(f) {
  await f.broker.submit(jobInput());
  const result = await request(f.broker, `${BASE}/claim`, { workerId: WORKER, protocolVersion: 1 });
  assert.equal(result.status, 200); return result.body.job;
}
const lookup = (f, lease, extra = {}, options) => request(f.broker, `${BASE}/jobs/${lease.id}/terminal-status`, { ...identity(lease), ...extra }, options);
async function snapshot(f) {
  const stat = await fs.stat(f.ledgerFile);
  return { raw: await fs.readFile(f.ledgerFile, "utf8"), mtimeMs: stat.mtimeMs, size: stat.size };
}
function artifacts(extra = {}) {
  const manifest = { ...jobInput().payload, outputDir: `/fixture/${RUN}`, collectedAt: "2026-10-25T02:01:00Z",
    checkIn: "2026-10-25", checkOut: "2026-11-24", collectionMode: "precision", collectionPurpose: "revenue_detail",
    detailRankRanges: "1-20", bookingRangeDays: 31, productMode: "all", workerCollection: true,
    naverAttemptedQueries: [{ status: 200 }], files: ["rows.csv"], fileRoles: { overall: "rows.csv" },
    detailJsonFiles: [{ file: "details/items.json", itemCount: 1 }],
    counts: { naverOverall: 2, naverBookingStockChecked: 2, naverBookingStockSucceeded: 2,
      naverOtaObservationChecked: 2, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 62, naverScheduleSucceeded: 62, naverScheduleFailed: 0, naverScheduleBlocked: 0 }, ...extra };
  const contents = { "manifest.json": Buffer.from(JSON.stringify(manifest)), "rows.csv": Buffer.from("name,detail\nfixture,@json-file:details/items.json\n"),
    "details/items.json": Buffer.from('[{"date":"2026-10-25","stock":1}]') };
  return { contents, files: Object.entries(contents).map(([name, buffer]) => ({ path: name, size: buffer.length, sha256: sha(buffer) })) };
}
async function complete(f, lease, bundle) {
  for (const [name, buffer] of Object.entries(bundle.contents)) {
    const result = await request(f.broker, `${BASE}/jobs/${lease.id}/files?path=${encodeURIComponent(name)}`, buffer,
      { method: "PUT", headers: { "x-collector-worker": WORKER, "x-collector-lease": lease.leaseToken, "x-content-sha256": sha(buffer) } });
    assert.equal(result.status, 200, result.body?.error);
  }
  const result = await request(f.broker, `${BASE}/jobs/${lease.id}/complete`, { ...identity(lease), runId: RUN, files: bundle.files }, { loseReply: true });
  assert.equal(result.status, 200);
}

test("terminal lookup before broker initialization creates and recovers nothing", async t => {
  const f = await fixture(t, {}, false);
  const lease = { id: `collector_${crypto.randomUUID()}`, leaseToken: "x".repeat(64) };
  assert.equal((await lookup(f, lease)).status, 503);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test("lost failure ACK is confirmed from disk without changing halt, freshness or expired jobs", async t => {
  const f = await fixture(t), lease = await claimed(f);
  await f.broker.submit(jobInput());
  await request(f.broker, `${BASE}/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_HEARTBEAT_FAILED" }, { loseReply: true });
  const before = await snapshot(f); f.advance(2 * LEASE_MS);
  const result = await lookup(f, lease);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "failed"); assert.equal(result.body.terminal, true);
  assert.equal(result.body.leaseReleased, true); assert.equal(result.body.errorCode, "COLLECTOR_HEARTBEAT_FAILED");
  assert.equal(result.body.jobId, lease.id); assert.ok(Date.parse(result.body.finishedAt));
  assert.deepEqual(await snapshot(f), before);
  const exposed = JSON.stringify(result.body);
  for (const secret of [TOKEN, lease.leaseToken, sha(lease.leaseToken), "manifest", "outputDir", "context", "keyword"]) assert.equal(exposed.includes(secret), false);
  const claim = await request(f.broker, `${BASE}/claim`, { workerId: WORKER, protocolVersion: 1 });
  assert.equal(claim.body.job, null);
});

test("lookup never expires a leased job or treats committing/interrupted as acknowledged", async t => {
  const f = await fixture(t), lease = await claimed(f), before = await snapshot(f);
  f.advance(LEASE_MS + 1);
  assert.equal((await lookup(f, lease)).body.terminal, false);
  assert.deepEqual(await snapshot(f), before);
  const ledger = await f.ledger();
  for (const status of ["committing", "interrupted"]) {
    Object.assign(ledger.jobs[0], { status, finishedAt: "2026-10-25T02:01:00Z", leaseReleasedAt: "2026-10-25T02:01:00Z" });
    await fs.writeFile(f.ledgerFile, JSON.stringify(ledger));
    const snapshotBefore = await snapshot(f);
    assert.equal((await lookup(f, lease)).body.terminal, false);
    assert.deepEqual(await snapshot(f), snapshotBefore);
  }
});

test("a cancellation with an active lease is not terminal until release is persisted", async t => {
  const f = await fixture(t), lease = await claimed(f);
  await f.broker.cancel(lease.id);
  assert.equal((await lookup(f, lease)).body.terminal, false);
  await request(f.broker, `${BASE}/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_CANCELLED" });
  const result = await lookup(f, lease);
  assert.equal(result.body.status, "cancelled"); assert.equal(result.body.terminal, true);
});

test("completion proof matches exactly the uploaded run and canonical descriptor set", async t => {
  const f = await fixture(t), lease = await claimed(f), bundle = artifacts();
  await complete(f, lease, bundle);
  const before = await snapshot(f);
  const proof = (await lookup(f, lease, { runId: RUN, files: [...bundle.files].reverse() })).body;
  assert.equal(proof.status, "completed"); assert.equal(proof.terminal, true); assert.equal(proof.completionMatches, true);
  assert.equal(proof.qualityStatus, "complete"); assert.equal(proof.collectionFailed, false);
  assert.equal((await lookup(f, lease)).body.completionMatches, false);
  assert.equal((await lookup(f, lease, { runId: "other_glamping_20261025", files: bundle.files })).body.completionMatches, false);
  const different = bundle.files.map(file => ({ ...file, sha256: "f".repeat(64) }));
  assert.equal((await lookup(f, lease, { runId: RUN, files: different })).body.completionMatches, false);
  assert.equal((await lookup(f, lease, { runId: RUN })).status, 400);
  assert.equal((await lookup(f, lease, { files: bundle.files })).status, 400);
  assert.equal((await lookup(f, lease, { runId: RUN, files: [...bundle.files, bundle.files[0]] })).status, 400);
  assert.deepEqual(await snapshot(f), before);
});

test("stored block/failure result remains visible after a lost completion ACK", async t => {
  for (const extra of [{ collectionFailed: true }, { naverAttemptedQueries: [{ status: 429 }] }]) {
    const f = await fixture(t), lease = await claimed(f), bundle = artifacts(extra);
    await complete(f, lease, bundle);
    const before = await snapshot(f), proof = (await lookup(f, lease, { runId: RUN, files: bundle.files })).body;
    assert.equal(proof.completionMatches, true);
    if (extra.collectionFailed) { assert.equal(proof.collectionFailed, true); assert.equal(proof.qualityStatus, "failed"); }
    else { assert.equal(proof.providerBlocked, true); assert.equal(proof.qualityStatus, "blocked"); }
    assert.deepEqual(await snapshot(f), before);
    assert.ok((await f.ledger()).halted);
  }
});

test("a missing or malformed completed manifest cannot be turned into successful proof", async t => {
  const f = await fixture(t), lease = await claimed(f), bundle = artifacts();
  await complete(f, lease, bundle);
  const ledger = await f.ledger();
  for (const manifest of [undefined, null, [], {}, { workerCollection: true, collectionFailed: "unknown" }]) {
    ledger.jobs[0].manifest = manifest;
    await fs.writeFile(f.ledgerFile, JSON.stringify(ledger));
    const before = await snapshot(f), proof = (await lookup(f, lease, { runId: RUN, files: bundle.files })).body;
    assert.equal(proof.terminal, false); assert.equal(proof.completionMatches, false);
    assert.equal(Object.hasOwn(proof, "collectionFailed"), false);
    assert.deepEqual(await snapshot(f), before);
  }
});

test("bearer, worker and exact lease proof are required; secrets are not returned", async t => {
  const f = await fixture(t), lease = await claimed(f), before = await snapshot(f);
  assert.equal((await lookup(f, lease, {}, { headers: { authorization: "Bearer incorrect" } })).status, 401);
  assert.equal((await lookup(f, lease, { workerId: "wrong-worker" })).status, 403);
  for (const leaseToken of ["short", "x".repeat(64), null, "x".repeat(257)]) {
    const response = await lookup(f, lease, { leaseToken });
    assert.equal(response.status, 409); assert.equal(response.body.error, "COLLECTOR_LEASE_MISMATCH");
  }
  assert.equal((await lookup(f, { ...lease, id: `collector_${crypto.randomUUID()}` })).status, 404);
  assert.equal((await lookup(f, lease, {}, { method: "GET" })).status, 405);
  assert.deepEqual(await snapshot(f), before);
});

test("only durable state is authoritative even when in-memory state has a different terminal outcome", async t => {
  const f = await fixture(t), lease = await claimed(f), activeLedger = await f.ledger();
  await request(f.broker, `${BASE}/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_CRAWL_FAILED" });
  await fs.writeFile(f.ledgerFile, JSON.stringify(activeLedger));
  const before = await snapshot(f), result = await lookup(f, lease);
  assert.equal(result.body.status, "leased"); assert.equal(result.body.terminal, false);
  assert.deepEqual(await snapshot(f), before);
});

test("a terminal receipt can be read after archival without restoring it to the ledger", async t => {
  const f = await fixture(t), lease = await claimed(f);
  await request(f.broker, `${BASE}/jobs/${lease.id}/fail`, { ...identity(lease), code: "COLLECTOR_CRAWL_FAILED" });
  const ledger = await f.ledger(), job = ledger.jobs.pop();
  const receipt = path.join(f.dataDir, "collector", "receipts", `${lease.id}.json`);
  await fs.writeFile(receipt, JSON.stringify(job)); await fs.writeFile(f.ledgerFile, JSON.stringify(ledger));
  const before = await snapshot(f), receiptBefore = await fs.readFile(receipt, "utf8");
  assert.equal((await lookup(f, lease)).body.terminal, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await fs.readFile(receipt, "utf8"), receiptBefore);
});

test("malformed, duplicate, incomplete and oversized disk evidence never confirms termination", async t => {
  const f = await fixture(t), lease = await claimed(f), ledger = await f.ledger();
  await fs.writeFile(f.ledgerFile, "{"); assert.equal((await lookup(f, lease)).status, 503);
  await fs.writeFile(f.ledgerFile, JSON.stringify({ ...ledger, jobs: [ledger.jobs[0], ledger.jobs[0]] }));
  assert.equal((await lookup(f, lease)).status, 503);
  for (const invalid of [{ status: "failed", leaseReleasedAt: "invalid", finishedAt: "2026-10-25T02:00:00Z" },
    { status: "failed", leaseReleasedAt: "2026-10-25T02:00:00Z", finishedAt: "2026-10-25T02:01:00Z" },
    { status: "failed", leaseReleasedAt: "2026-02-31T02:00:00.000Z", finishedAt: "2026-02-31T02:00:00.000Z" },
    { status: "failed", leaseReleasedAt: "0", finishedAt: "0" },
    { status: "completed", leaseReleasedAt: "2026-10-25T02:00:00Z", finishedAt: "2026-10-25T02:00:00Z" }]) {
    await fs.writeFile(f.ledgerFile, JSON.stringify({ ...ledger, jobs: [{ ...ledger.jobs[0], ...invalid }] }));
    assert.equal((await lookup(f, lease)).body.terminal, false);
  }
  await fs.truncate(f.ledgerFile, 64 * 1024 * 1024 + 1);
  assert.equal((await lookup(f, lease)).status, 503);
});

test("hard-linked evidence is refused without touching either copy", async t => {
  const f = await fixture(t), lease = await claimed(f);
  const link = path.join(f.temporary, "ledger-hardlink.json");
  await fs.link(f.ledgerFile, link); const before = await fs.readFile(link, "utf8");
  assert.equal((await lookup(f, lease)).status, 503);
  assert.equal(await fs.readFile(link, "utf8"), before); assert.equal(await fs.readFile(f.ledgerFile, "utf8"), before);
});
