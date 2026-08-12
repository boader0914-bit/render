const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const actualBullMq = require("bullmq");
const {
  FIXTURE_JOB_POLICY,
  JOB_SCHEMA,
  RESULT_SCHEMA,
  computeSignature,
  normalizeResult,
  signJob
} = require("./v4_fixture_job_contract.cjs");
const { assertTransportInterface } = require("./v4_fixture_transport.cjs");
const { initializeFixtureTransport } = require("./v4_fixture_transport_fs.cjs");
const { loadSigningKeyring } = require("./v4_fixture_signing_keys.cjs");
const {
  SupervisorError,
  processNext,
  sanitizedJson,
  sensitiveValues
} = require("./v4_fixture_transport_supervisor.cjs");
const {
  BULLMQ_VERSION,
  DEFAULT_READY_TIMEOUT_MS,
  RenderKeyValueTransport,
  deterministicJobId,
  redisConnectionOptions
} = require("./v4_render_kv_transport.cjs");

const CURRENT_KEY_ID = "phase10-current-v2";
const CURRENT_SECRET = "phase10-current-synthetic-hmac-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PREVIOUS_KEY_ID = "phase10-previous-v1";
const PREVIOUS_SECRET = "phase10-previous-synthetic-hmac-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function baseJob(suffix, overrides = {}) {
  return {
    schemaVersion: JOB_SCHEMA,
    jobId: `phase10-${suffix}`,
    idempotencyKey: `phase10-key-${suffix}`,
    keyword: FIXTURE_JOB_POLICY.keyword,
    checkIn: "2026-08-12",
    checkOut: "2026-08-18",
    adults: 2,
    searchMode: "keyword",
    productMode: "all",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    detailRankRanges: "1-10",
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 10,
    ...overrides
  };
}

function signedJob(job, options = {}) {
  return signJob(job, {
    keyId: options.keyId || CURRENT_KEY_ID,
    secret: options.secret || CURRENT_SECRET,
    scenario: options.scenario || "success",
    nonce: options.nonce || `nonce-${job.jobId}-${crypto.randomBytes(8).toString("hex")}`,
    nowMs: options.nowMs
  });
}

function succeededResult(envelope, attemptId, nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString();
  return normalizeResult({
    schemaVersion: RESULT_SCHEMA,
    jobId: envelope.jobId,
    idempotencyKey: envelope.idempotencyKey,
    attemptId,
    status: "succeeded",
    stage: "complete",
    code: "OK",
    matched: true,
    actualExternalRequests: 0,
    operationalWrites: false,
    collectorInvocations: 1,
    exitCode: 0,
    artifactManifestDigest: "b".repeat(64),
    startedAt: timestamp,
    completedAt: timestamp,
    retryable: false,
    scenario: envelope.scenario
  });
}

async function assertRejected(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

function createFakeBullMq() {
  const namespaces = new Map();
  let online = true;

  function key(name, opts) {
    return `${opts.prefix}|${name}`;
  }

  function stateFor(name, opts) {
    const namespace = key(name, opts);
    if (!namespaces.has(namespace)) {
      namespaces.set(namespace, {
        jobs: new Map(),
        deduplication: new Map(),
        workerOptions: [],
        failAfterAddAck: false,
        failAfterCompleteAck: false,
        failAfterFailAck: false
      });
    }
    return namespaces.get(namespace);
  }

  function requireOnline() {
    if (!online) throw new Error("synthetic redis outage");
  }

  class FakeJob {
    constructor(store, record) {
      this.store = store;
      this.record = record;
    }

    get id() { return this.record.id; }
    get data() { return this.record.data; }
    get opts() { return this.record.opts; }
    get returnvalue() { return this.record.returnvalue; }
    get failedReason() { return this.record.failedReason; }
    get stalledCounter() { return this.record.stalledCounter; }
    get timestamp() { return this.record.timestamp; }
    get processedOn() { return this.record.processedOn; }
    get finishedOn() { return this.record.finishedOn; }

    async getState() {
      requireOnline();
      return this.record.state;
    }

    async extendLock(token, duration) {
      requireOnline();
      if (this.record.state !== "active" || this.record.token !== token) return 0;
      this.record.lockExpiresAt = Date.now() + duration;
      this.record.heartbeatCount += 1;
      return 1;
    }

    async moveToCompleted(result, token) {
      requireOnline();
      if (this.record.state !== "active" || this.record.token !== token) throw new Error("missing lock");
      this.record.state = "completed";
      this.record.returnvalue = structuredClone(result);
      this.record.finishedOn = Date.now();
      this.record.token = null;
      if (this.store.failAfterCompleteAck) {
        this.store.failAfterCompleteAck = false;
        throw new Error("synthetic completion acknowledgement loss");
      }
    }

    async moveToFailed(error, token) {
      requireOnline();
      if (this.record.state !== "active" || this.record.token !== token) throw new Error("missing lock");
      this.record.state = "failed";
      this.record.failedReason = String(error?.message || "failed");
      this.record.finishedOn = Date.now();
      this.record.token = null;
      if (this.store.failAfterFailAck) {
        this.store.failAfterFailAck = false;
        throw new Error("synthetic failure acknowledgement loss");
      }
    }
  }

  class Queue extends EventEmitter {
    constructor(name, opts) {
      super();
      this.name = name;
      this.opts = opts;
      this.store = stateFor(name, opts);
    }

    async waitUntilReady() {
      requireOnline();
      return this;
    }

    async getDeduplicationJobId(id) {
      requireOnline();
      const record = this.store.deduplication.get(id);
      if (!record) return null;
      if (record.expiresAt <= Date.now()) {
        this.store.deduplication.delete(id);
        return null;
      }
      return record.jobId;
    }

    async getJob(id) {
      requireOnline();
      const record = this.store.jobs.get(String(id));
      return record ? new FakeJob(this.store, record) : null;
    }

    async add(name, data, opts) {
      requireOnline();
      const deduplicationId = opts.deduplication?.id;
      if (deduplicationId) {
        const existingId = await this.getDeduplicationJobId(deduplicationId);
        if (existingId) return this.getJob(existingId);
      }
      if (this.store.jobs.has(String(opts.jobId))) return this.getJob(opts.jobId);
      const record = {
        id: String(opts.jobId),
        name,
        data: structuredClone(data),
        opts: structuredClone(opts),
        state: "waiting",
        timestamp: Date.now(),
        processedOn: null,
        finishedOn: null,
        returnvalue: null,
        failedReason: "",
        stalledCounter: 0,
        token: null,
        lockExpiresAt: null,
        heartbeatCount: 0
      };
      this.store.jobs.set(record.id, record);
      if (deduplicationId) {
        this.store.deduplication.set(deduplicationId, {
          jobId: record.id,
          expiresAt: Date.now() + Number(opts.deduplication.ttl || 0)
        });
      }
      if (this.store.failAfterAddAck) {
        this.store.failAfterAddAck = false;
        throw new Error("synthetic enqueue acknowledgement loss");
      }
      return new FakeJob(this.store, record);
    }

    async close() {}
  }

  class Worker extends EventEmitter {
    constructor(name, processor, opts) {
      super();
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      this.store = stateFor(name, opts);
      this.store.workerOptions.push(opts);
    }

    async waitUntilReady() {
      requireOnline();
      return this;
    }

    async startStalledCheckTimer() {
      requireOnline();
      this.stalledStarted = true;
    }

    async getNextJob(token) {
      requireOnline();
      const record = [...this.store.jobs.values()].find((candidate) => candidate.state === "waiting");
      if (!record) return undefined;
      record.state = "active";
      record.token = token;
      record.processedOn = Date.now();
      record.lockExpiresAt = Date.now() + Number(this.opts.lockDuration);
      return new FakeJob(this.store, record);
    }

    async close() {}
  }

  return {
    Queue,
    Worker,
    setOnline(value) { online = value === true; },
    namespace(prefix, name) { return namespaces.get(`${prefix}|${name}`); },
    failAfter(prefix, name, operation) {
      const store = namespaces.get(`${prefix}|${name}`);
      store[operation] = true;
    },
    forceStall(prefix, name) {
      const store = namespaces.get(`${prefix}|${name}`);
      const workerOptions = store.workerOptions.at(-1);
      for (const record of store.jobs.values()) {
        if (record.state !== "active") continue;
        record.stalledCounter += 1;
        record.token = null;
        if (workerOptions.maxStalledCount === 0) {
          record.state = "failed";
          record.failedReason = "job stalled more than allowable limit";
          record.finishedOn = Date.now();
        } else {
          record.state = "waiting";
        }
      }
    }
  };
}

function createDelayedBullMqLifecycle(options = {}) {
  const metrics = {
    clients: [],
    earlyInfoCalls: 0,
    infoCalls: 0,
    metadataWrites: 0,
    transientErrors: 0
  };
  const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : 25;
  const previousFactory = actualBullMq.RedisConnection.clientFactory;

  class DelayedKeyValueClient extends EventEmitter {
    constructor(connectionOptions) {
      super();
      this.options = connectionOptions;
      this.status = "connecting";
      this.timer = options.neverReady === true ? null : setTimeout(() => {
        this.status = "ready";
        this.emit("ready");
      }, delayMs);
      this.errorTimer = Number.isInteger(options.errorBeforeReadyMs) ? setTimeout(() => {
        metrics.transientErrors += 1;
        this.emit("error", new Error("synthetic transient connection error"));
      }, options.errorBeforeReadyMs) : null;
      metrics.clients.push(this);
    }

    defineCommand(name) {
      this[name] = async () => null;
    }

    async info() {
      metrics.infoCalls += 1;
      if (this.status !== "ready") {
        metrics.earlyInfoCalls += 1;
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return "# Server\nvalkey_version:8.1.4\n# Memory\nmaxmemory_policy:noeviction\n";
    }

    async hset() {
      if (this.status !== "ready") throw new Error("metadata write before readiness");
      metrics.metadataWrites += 1;
      return 1;
    }

    async quit() {
      this.disconnect();
      return "OK";
    }

    disconnect() {
      if (this.timer) clearTimeout(this.timer);
      if (this.errorTimer) clearTimeout(this.errorTimer);
      this.timer = null;
      this.errorTimer = null;
      if (this.status === "end") return;
      this.status = "end";
      this.emit("end");
    }
  }

  actualBullMq.RedisConnection.clientFactory = (connectionOptions) => (
    new DelayedKeyValueClient(connectionOptions)
  );

  return {
    bullmq: actualBullMq,
    metrics,
    restore() {
      actualBullMq.RedisConnection.clientFactory = previousFactory;
      for (const client of metrics.clients) client.disconnect();
    }
  };
}

function transportOptions(fake, keyring, suffix, overrides = {}) {
  return {
    redisUrl: "redis://fixture.invalid:6379",
    queueName: `jobs-${suffix}`,
    prefix: `datalab-${suffix}`,
    resolveKey: keyring.resolveKey,
    claimsEnabled: true,
    leaseMs: 5000,
    stalledIntervalMs: 1000,
    retentionSeconds: 3600,
    nonceRetentionMs: 3600 * 1000,
    completedCount: 100,
    failedCount: 500,
    bullmq: fake,
    bullmqVersion: BULLMQ_VERSION,
    ...overrides
  };
}

async function newTransport(fake, keyring, suffix, overrides = {}) {
  const transport = new RenderKeyValueTransport(transportOptions(fake, keyring, suffix, overrides));
  await transport.ready();
  return transport;
}

async function main() {
  assert.equal(globalThis.__DATALAB_V4_NETWORK_BLOCKED__, true);
  assert.throws(() => require("node:https").get("https://example.invalid"), { code: "V4_OFFLINE_NETWORK_BLOCKED" });
  const keyring = loadSigningKeyring({
    V4_FIXTURE_JOB_KEY_ID_CURRENT: CURRENT_KEY_ID,
    V4_FIXTURE_JOB_HMAC_KEY_CURRENT: CURRENT_SECRET,
    V4_FIXTURE_JOB_KEY_ID_PREVIOUS: PREVIOUS_KEY_ID,
    V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS: PREVIOUS_SECRET
  });
  assert.deepEqual(keyring.acceptedKeyIds, [CURRENT_KEY_ID, PREVIOUS_KEY_ID]);
  const fake = createFakeBullMq();
  const passed = [];
  const mark = (name) => passed.push(name);

  const normal = await newTransport(fake, keyring, "normal");
  assertTransportInterface(normal);
  assert.equal(normal.queue.opts.defaultJobOptions.attempts, 1);
  assert.equal(normal.worker.opts.concurrency, 1);
  assert.equal(normal.worker.opts.maxStalledCount, 0);
  assert.equal(normal.worker.opts.autorun, false);
  assert.equal(normal.worker.opts.lockDuration, 5000);
  assert.equal(normal.config.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  assert.deepEqual(redisConnectionOptions("rediss://queue-user:queue-pass@kv.internal:6380/2"), {
    host: "kv.internal",
    port: 6380,
    username: "queue-user",
    password: "queue-pass",
    db: 2,
    tls: {}
  });
  assert.equal("url" in normal.queue.opts.connection, false);
  mark("interface-and-no-auto-retry-options");

  const producerOnly = await newTransport(fake, keyring, "producer-only", { claimsEnabled: false });
  assert.equal(producerOnly.worker, null);
  assert.equal(await producerOnly.claim("phase10-disabled-worker", 5000), null);
  mark("producer-only-no-consumer-connection");

  const delayedLifecycle = createDelayedBullMqLifecycle({ delayMs: 30, errorBeforeReadyMs: 5 });
  let delayedReadiness;
  try {
    delayedReadiness = new RenderKeyValueTransport(transportOptions(
      delayedLifecycle.bullmq,
      keyring,
      "delayed-readiness",
      { claimsEnabled: false }
    ));
    const readinessPromiseA = delayedReadiness.ready();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const readinessPromiseB = delayedReadiness.ready();
    const [readinessA, readinessB] = await Promise.all([readinessPromiseA, readinessPromiseB]);
    assert.deepEqual(readinessA, { ready: true, claimsEnabled: false });
    assert.deepEqual(readinessB, readinessA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(delayedReadiness.queue.opts.skipWaitingForReady, true);
    assert.equal(delayedLifecycle.metrics.clients.length, 1);
    assert.equal(delayedLifecycle.metrics.earlyInfoCalls, 0);
    assert.equal(delayedLifecycle.metrics.infoCalls, 1);
    assert.equal(delayedLifecycle.metrics.metadataWrites, 1);
    assert.equal(delayedLifecycle.metrics.transientErrors, 1);
    delayedLifecycle.metrics.clients[0].emit("close");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delayedReadiness.readiness().ready, false);
    await assertRejected(delayedReadiness.ready(), "V4_QUEUE_UNAVAILABLE");
  } finally {
    await delayedReadiness?.close().catch(() => {});
    delayedLifecycle.restore();
  }
  mark("transient-error-delayed-key-value-ready-before-info");
  mark("connection-loss-clears-readiness");

  const timeoutLifecycle = createDelayedBullMqLifecycle({ neverReady: true });
  let timeoutReadiness;
  try {
    timeoutReadiness = new RenderKeyValueTransport(transportOptions(
      timeoutLifecycle.bullmq,
      keyring,
      "readiness-timeout",
      { claimsEnabled: false, readyTimeoutMs: 100 }
    ));
    const timeoutStartedAt = Date.now();
    await assertRejected(timeoutReadiness.ready(), "V4_QUEUE_UNAVAILABLE");
    assert.ok(Date.now() - timeoutStartedAt >= 80);
    assert.ok(Date.now() - timeoutStartedAt < 1000);
    assert.equal(timeoutReadiness.readiness().ready, false);
    assert.equal(timeoutLifecycle.metrics.earlyInfoCalls, 0);
    assert.equal(timeoutLifecycle.metrics.infoCalls, 0);
    assert.equal(timeoutLifecycle.metrics.metadataWrites, 0);
  } finally {
    await timeoutReadiness?.close().catch(() => {});
    timeoutLifecycle.restore();
  }
  mark("readiness-timeout-fails-closed");

  const shutdownLifecycle = createDelayedBullMqLifecycle({ neverReady: true });
  let shutdownReadiness;
  try {
    shutdownReadiness = new RenderKeyValueTransport(transportOptions(
      shutdownLifecycle.bullmq,
      keyring,
      "readiness-shutdown",
      { claimsEnabled: false, readyTimeoutMs: 1000 }
    ));
    const readinessOutcome = shutdownReadiness.ready().then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", code: error?.code })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closeStartedAt = Date.now();
    await shutdownReadiness.close();
    assert.ok(Date.now() - closeStartedAt < 500);
    assert.deepEqual(await readinessOutcome, { status: "rejected", code: "V4_QUEUE_UNAVAILABLE" });
    assert.equal(shutdownReadiness.readiness().ready, false);
    assert.equal(shutdownLifecycle.metrics.earlyInfoCalls, 0);
    assert.equal(shutdownLifecycle.metrics.infoCalls, 0);
  } finally {
    await shutdownReadiness?.close().catch(() => {});
    shutdownLifecycle.restore();
  }
  mark("shutdown-during-readiness-fails-closed");

  const now = Date.now();
  const job = baseJob("normal");
  const envelope = signedJob(job, { nowMs: now, nonce: "nonce-phase10-normal-0001" });
  assert.equal((await normal.enqueue(envelope, { nowMs: now })).status, "queued");
  const claim = await normal.claim("phase10-worker-a", 5000, { nowMs: now });
  assert.equal(claim.envelope.jobId, job.jobId);
  assert.equal((await normal.heartbeat(claim.claimId)).claimId, claim.claimId);
  const result = succeededResult(envelope, claim.claimId, now + 1);
  assert.deepEqual(await normal.complete(claim.claimId, result), result);
  assert.deepEqual(await normal.getResult(job.idempotencyKey), result);
  mark("signed-enqueue-claim-heartbeat-complete");

  const duplicate = signedJob(job, { nowMs: now + 2, nonce: "nonce-phase10-normal-0002" });
  const duplicateResponse = await normal.enqueue(duplicate, { nowMs: now + 2 });
  assert.equal(duplicateResponse.status, "duplicate");
  assert.equal(duplicateResponse.collectorInvocations, 0);
  await assertRejected(normal.enqueue(envelope, { nowMs: now + 2 }), "FIXTURE_NONCE_REPLAY");
  mark("terminal-replay-and-nonce-replay");

  const conflict = { ...job, checkOut: "2026-08-19" };
  await assertRejected(
    normal.enqueue(signedJob(conflict, { nowMs: now + 3, nonce: "nonce-phase10-conflict-0001" }), { nowMs: now + 3 }),
    "FIXTURE_IDEMPOTENCY_CONFLICT"
  );
  mark("idempotency-conflict");

  const concurrentProducer = await newTransport(fake, keyring, "producer-race");
  const concurrentProducerEnvelope = signedJob(baseJob("producer-race"), { nowMs: now });
  const concurrentProducerResults = await Promise.allSettled([
    concurrentProducer.enqueue(concurrentProducerEnvelope, { nowMs: now }),
    concurrentProducer.enqueue(concurrentProducerEnvelope, { nowMs: now })
  ]);
  assert.equal(concurrentProducerResults.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(
    concurrentProducerResults.find((entry) => entry.status === "rejected")?.reason?.code,
    "FIXTURE_NONCE_REPLAY"
  );
  mark("concurrent-producer-atomic-replay-detection");

  const badSignature = signedJob(baseJob("bad-signature"), { nowMs: now });
  badSignature.signature = `${badSignature.signature.slice(0, -1)}${badSignature.signature.endsWith("0") ? "1" : "0"}`;
  await assertRejected(normal.enqueue(badSignature, { nowMs: now }), "FIXTURE_SIGNATURE_INVALID");
  const unknown = signedJob(baseJob("unknown-key"), {
    keyId: "phase10-unknown-v1",
    secret: "phase10-unknown-synthetic-hmac-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    nowMs: now
  });
  await assertRejected(normal.enqueue(unknown, { nowMs: now }), "FIXTURE_KEY_ID_UNKNOWN");
  const tampered = signedJob(baseJob("tampered"), { nowMs: now });
  tampered.job.keyword = "forbidden live payload";
  await assertRejected(normal.enqueue(tampered, { nowMs: now }), "FIXTURE_PAYLOAD_DIGEST_MISMATCH");
  mark("invalid-signatures-before-queue");

  const expired = signedJob(baseJob("expired"), { nowMs: now - (10 * 60 * 1000) });
  await assertRejected(normal.enqueue(expired, { nowMs: now }), "FIXTURE_JOB_EXPIRED");
  const future = signedJob(baseJob("future"), { nowMs: now + (10 * 60 * 1000) });
  await assertRejected(normal.enqueue(future, { nowMs: now }), "FIXTURE_JOB_FROM_FUTURE");
  mark("expired-and-future-jobs-before-queue");

  const previous = signedJob(baseJob("previous-key"), {
    keyId: PREVIOUS_KEY_ID,
    secret: PREVIOUS_SECRET,
    nowMs: now
  });
  assert.equal((await normal.enqueue(previous, { nowMs: now })).status, "queued");
  const previousClaim = await normal.claim("phase10-worker-previous", 5000, { nowMs: now });
  assert.equal(previousClaim.envelope.keyId, PREVIOUS_KEY_ID);
  await normal.complete(previousClaim.claimId, succeededResult(previous, previousClaim.claimId, now + 1));
  mark("current-previous-key-overlap");

  const concurrentA = await newTransport(fake, keyring, "concurrent");
  const concurrentB = await newTransport(fake, keyring, "concurrent");
  const concurrentEnvelope = signedJob(baseJob("concurrent"), { nowMs: now });
  await concurrentA.enqueue(concurrentEnvelope, { nowMs: now });
  const competing = await Promise.all([
    concurrentA.claim("phase10-consumer-a", 5000, { nowMs: now }),
    concurrentB.claim("phase10-consumer-b", 5000, { nowMs: now })
  ]);
  assert.equal(competing.filter(Boolean).length, 1);
  const owned = competing.find(Boolean);
  const ownerTransport = competing[0] ? concurrentA : concurrentB;
  await ownerTransport.complete(owned.claimId, succeededResult(concurrentEnvelope, owned.claimId, now + 1));
  mark("two-consumers-single-claim");

  const stalledA = await newTransport(fake, keyring, "stalled");
  const stalledB = await newTransport(fake, keyring, "stalled");
  const stalledEnvelope = signedJob(baseJob("stalled"), { nowMs: now });
  await stalledA.enqueue(stalledEnvelope, { nowMs: now });
  await stalledA.claim("phase10-stalled-a", 5000, { nowMs: now });
  fake.forceStall("datalab-stalled", "jobs-stalled");
  const stalledResult = await stalledB.getResult(stalledEnvelope.idempotencyKey);
  assert.equal(stalledResult.code, "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY");
  assert.equal(stalledResult.collectorInvocations, 1);
  assert.equal(await stalledB.claim("phase10-stalled-b", 5000), null);
  mark("stalled-terminal-no-redelivery");

  const ack = await newTransport(fake, keyring, "ack-loss");
  const ackEnvelope = signedJob(baseJob("ack-loss"), { nowMs: now });
  await ack.enqueue(ackEnvelope, { nowMs: now });
  const ackClaim = await ack.claim("phase10-ack-worker", 5000, { nowMs: now });
  const ackResult = succeededResult(ackEnvelope, ackClaim.claimId, now + 1);
  fake.failAfter("datalab-ack-loss", "jobs-ack-loss", "failAfterCompleteAck");
  assert.deepEqual(await ack.complete(ackClaim.claimId, ackResult), ackResult);
  assert.deepEqual(await ack.getResult(ackEnvelope.idempotencyKey), ackResult);
  mark("result-commit-ack-loss-recovery");

  const enqueueAck = await newTransport(fake, keyring, "enqueue-ack-loss");
  const enqueueAckEnvelope = signedJob(baseJob("enqueue-ack-loss"), { nowMs: now });
  fake.failAfter("datalab-enqueue-ack-loss", "jobs-enqueue-ack-loss", "failAfterAddAck");
  await assertRejected(enqueueAck.enqueue(enqueueAckEnvelope, { nowMs: now }), "V4_QUEUE_UNAVAILABLE");
  assert.equal(await enqueueAck.getResult(enqueueAckEnvelope.idempotencyKey), null);
  const enqueueAckClaim = await enqueueAck.claim("phase10-enqueue-ack-worker", 5000, { nowMs: now });
  const enqueueAckResult = succeededResult(enqueueAckEnvelope, enqueueAckClaim.claimId, now + 1);
  await enqueueAck.complete(enqueueAckClaim.claimId, enqueueAckResult);
  assert.deepEqual(await enqueueAck.getResult(enqueueAckEnvelope.idempotencyKey), enqueueAckResult);
  mark("enqueue-ack-loss-result-lookup");

  const shutdown = await newTransport(fake, keyring, "shutdown");
  const shutdownEnvelope = signedJob(baseJob("shutdown"), { nowMs: now });
  await shutdown.enqueue(shutdownEnvelope, { nowMs: now });
  const shutdownClaim = await shutdown.claim("phase10-shutdown-worker", 5000, { nowMs: now });
  shutdown.stopIntake();
  const shutdownResult = await shutdown.releaseOnShutdown(shutdownClaim.claimId, { startedAt: shutdownClaim.claimedAt });
  assert.equal(shutdownResult.code, "FIXTURE_SHUTDOWN_RELEASED");
  assert.equal(await shutdown.claim("phase10-drained-worker", 5000), null);
  mark("sigterm-drain-contract");

  const partial = await newTransport(fake, keyring, "partial-artifact");
  const partialEnvelope = signedJob(baseJob("partial-artifact"), { nowMs: now });
  await partial.enqueue(partialEnvelope, { nowMs: now });
  const partialRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-kv-partial-"));
  try {
    const roots = await initializeFixtureTransport(partialRoot);
    const partialResult = await processNext(roots, {
      transportMode: "render-key-value",
      transportRoot: roots.root,
      keyId: CURRENT_KEY_ID,
      secret: CURRENT_SECRET,
      resolveKey: keyring.resolveKey,
      leaseMs: 5000,
      heartbeatMs: 1000,
      pollMs: 250,
      childTimeoutMs: 60000,
      workerId: "phase10-partial-worker"
    }, {
      transport: partial,
      nowMs: now,
      runParity: async () => {
        const isolated = path.join(roots.runs, "isolated-partial-attempt");
        await fsp.mkdir(isolated);
        await fsp.writeFile(path.join(isolated, "partial.json"), "{}\n", "utf8");
        throw new SupervisorError("FIXTURE_PARTIAL_ARTIFACT", "artifact", "Synthetic partial artifact failure.", {
          collectorInvocations: 1,
          exitCode: 17
        });
      }
    });
    assert.equal(partialResult.code, "FIXTURE_PARTIAL_ARTIFACT");
    assert.equal(partialResult.artifactManifestDigest, null);
    assert.equal((await partial.getResult(partialEnvelope.idempotencyKey)).code, "FIXTURE_PARTIAL_ARTIFACT");
    assert.equal((await partial.enqueue(
      signedJob(baseJob("partial-artifact"), { nowMs: now + 1 }),
      { nowMs: now + 1 }
    )).collectorInvocations, 0);
  } finally {
    await fsp.rm(partialRoot, { recursive: true, force: true });
  }
  mark("partial-artifact-terminal-no-retry");

  const quarantine = await newTransport(fake, keyring, "quarantine");
  const quarantineEnvelope = signedJob(baseJob("quarantine"), { nowMs: now });
  await quarantine.enqueue(quarantineEnvelope, { nowMs: now });
  const quarantineStore = fake.namespace("datalab-quarantine", "jobs-quarantine");
  quarantineStore.jobs.get(deterministicJobId(quarantineEnvelope.idempotencyKey)).data.envelope.signature = "0".repeat(64);
  const rejected = await quarantine.claim("phase10-quarantine-worker", 5000, { nowMs: now });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.rejection.collectorInvocations, 0);
  mark("claim-time-verification-before-runner");

  const isolatedA = await newTransport(fake, keyring, "namespace-a");
  const isolatedB = await newTransport(fake, keyring, "namespace-b");
  const isolatedEnvelope = signedJob(baseJob("namespace"), { nowMs: now });
  assert.equal((await isolatedA.enqueue(isolatedEnvelope, { nowMs: now })).status, "queued");
  assert.equal((await isolatedB.enqueue(isolatedEnvelope, { nowMs: now })).status, "queued");
  assert.notEqual(isolatedA.queue.opts.prefix, isolatedB.queue.opts.prefix);
  mark("namespace-isolation");

  const outage = await newTransport(fake, keyring, "outage");
  fake.setOnline(false);
  await assertRejected(outage.enqueue(signedJob(baseJob("outage"), { nowMs: now }), { nowMs: now }), "V4_QUEUE_UNAVAILABLE");
  await assertRejected(outage.claim("phase10-outage-worker", 5000, { nowMs: now }), "V4_QUEUE_UNAVAILABLE");
  fake.setOnline(true);
  mark("queue-outage-fails-closed");

  const output = {
    schemaVersion: "datalab-v4-render-kv-transport-test.v1",
    status: "succeeded",
    nodeVersion: process.version,
    queueLibrary: `bullmq@${BULLMQ_VERSION}`,
    checks: passed,
    checkCount: passed.length,
    externalCalls: 0,
    operationalWrites: 0,
    redisSockets: 0,
    automaticRetries: 0
  };
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(CURRENT_SECRET), false);
  assert.equal(serialized.includes(PREVIOUS_SECRET), false);
  assert.equal(serialized.includes(envelope.signature), false);
  const secretRedisUrl = "rediss://queue-user:queue-password@kv.internal:6380/2";
  const logLine = sanitizedJson({ redis: secretRedisUrl, key: CURRENT_SECRET }, sensitiveValues({
    V4_QUEUE_REDIS_URL: secretRedisUrl,
    V4_FIXTURE_JOB_HMAC_KEY_CURRENT: CURRENT_SECRET,
    V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS: PREVIOUS_SECRET
  }));
  assert.equal(logLine.includes(secretRedisUrl), false);
  assert.equal(logLine.includes(CURRENT_SECRET), false);
  assert.equal(logLine.includes(PREVIOUS_SECRET), false);
  process.stdout.write(`${serialized}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
