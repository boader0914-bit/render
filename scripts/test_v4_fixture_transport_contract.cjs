const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  CONTRACT_BASELINE_COMMIT,
  EXPECTED_COLLECTOR_BLOB,
  FIXTURE_JOB_POLICY,
  JOB_SCHEMA,
  PURPOSE,
  RESULT_SCHEMA,
  computeSignature,
  normalizeResult,
  sha256,
  signJob,
  stableJson,
  verifySignedJob
} = require("./v4_fixture_job_contract.cjs");
const {
  claim,
  complete,
  enqueue,
  getResult,
  heartbeat,
  initializeFixtureTransport,
  readJson,
  recoverStaleClaims,
  writeJsonAtomic
} = require("./v4_fixture_transport_fs.cjs");
const {
  produceFixtureJob,
  validateProducerEnvironment
} = require("./v4_fixture_producer_simulator.cjs");
const {
  SupervisorError,
  acquireSupervisorLock,
  processNext,
  releaseSupervisorLock,
  validateSupervisorEnvironment
} = require("./v4_fixture_transport_supervisor.cjs");
const {
  FIXTURE_JOB,
  bootstrapFixture,
  validateBootstrapEnvironment
} = require("./v4_fixture_transport_shadow_host.cjs");
const {
  ORIGINAL_COLLECTOR,
  gitBlobSha
} = require("./v4_worker_once.cjs");

const ROOT = path.resolve(__dirname, "..");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const PRODUCER = path.join(__dirname, "v4_fixture_producer_simulator.cjs");
const LOCKFILE = path.join(ROOT, "package-lock.json");
const SIGNED_SCHEMA = path.join(ROOT, "schemas", "v4_fixture_signed_job.schema.json");
const RESULT_SCHEMA_FILE = path.join(ROOT, "schemas", "v4_fixture_result.schema.json");
const KEY_ID = "phase9-fixture-key-v1";
const SECRET = "phase9-synthetic-hmac-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const UNKNOWN_SECRET = "phase9-unknown-hmac-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PHASE9_LOCKFILE_SHA256 = "ec929b3a95d22b80837bd7e59d23ebc61040e5a11344590bfebb23c6880eb123";
const EXPECTED_LOCKFILE_SHA256 = "c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79";

function baseJob(suffix, overrides = {}) {
  return {
    schemaVersion: JOB_SCHEMA,
    jobId: `phase9-${suffix}`,
    idempotencyKey: `phase9-key-${suffix}`,
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
    keyId: options.keyId || KEY_ID,
    secret: options.secret || SECRET,
    scenario: options.scenario || "success",
    nonce: options.nonce || `nonce-${job.jobId}-${crypto.randomBytes(8).toString("hex")}`,
    nowMs: options.nowMs,
    ttlMs: options.ttlMs,
    purpose: options.purpose,
    requestedCommit: options.requestedCommit,
    collectorBlob: options.collectorBlob
  });
}

function resign(envelope, secret = SECRET) {
  const next = structuredClone(envelope);
  next.signature = computeSignature(next, secret);
  return next;
}

function verifyOptions(nowMs = Date.now()) {
  return {
    nowMs,
    resolveKey: (keyId) => keyId === KEY_ID ? SECRET : null
  };
}

function supervisorConfig(roots, overrides = {}) {
  return {
    transportRoot: roots.root,
    keyId: KEY_ID,
    secret: SECRET,
    leaseMs: 5000,
    heartbeatMs: 1000,
    pollMs: 250,
    childTimeoutMs: 120000,
    workerId: `phase9-worker-${crypto.randomBytes(5).toString("hex")}`,
    ...overrides
  };
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
    artifactManifestDigest: "a".repeat(64),
    startedAt: timestamp,
    completedAt: timestamp,
    retryable: false,
    scenario: envelope.scenario
  });
}

async function newRoots(temp, label) {
  return initializeFixtureTransport(path.join(temp, label));
}

async function jsonFiles(directory) {
  return (await fsp.readdir(directory)).filter((name) => name.endsWith(".json"));
}

async function allFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

async function assertNoValueInFiles(root, value, label) {
  const needle = Buffer.from(value, "utf8");
  for (const file of await allFiles(root)) {
    const bytes = await fsp.readFile(file);
    assert.equal(bytes.includes(needle), false, `${label} leaked into ${file}`);
  }
}

async function assertRejected(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected ${code}`);
}

async function assertEnqueueRejected(temp, label, envelope, code, options = verifyOptions()) {
  const roots = await newRoots(temp, `reject-${label}`);
  await assertRejected(enqueue(roots, envelope, options), code);
  assert.deepEqual(await jsonFiles(roots.queue), []);
  assert.deepEqual(await jsonFiles(roots.claims), []);
  assert.deepEqual(await jsonFiles(roots.results), []);
}

function producerEnvironment(root) {
  return {
    NODE_ENV: "test",
    V4_FIXTURE_TRANSPORT_MODE: "fixture",
    V4_FIXTURE_TRANSPORT_ROOT: root,
    V4_FIXTURE_JOB_KEY_ID: KEY_ID,
    V4_FIXTURE_JOB_HMAC_KEY: SECRET,
    V4_FIXTURE_EXTERNAL_CALLS_ENABLED: "0",
    V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED: "0",
    V4_FIXTURE_WEB_IMPORT_ENABLED: "0"
  };
}

function supervisorEnvironment(root) {
  return {
    ...producerEnvironment(root),
    V4_FIXTURE_WORKER_ID: "phase9-environment-worker",
    V4_FIXTURE_LEASE_MS: "5000",
    V4_FIXTURE_HEARTBEAT_MS: "1000",
    V4_FIXTURE_POLL_MS: "250",
    V4_FIXTURE_CHILD_TIMEOUT_MS: "120000"
  };
}

async function main() {
  assert.equal(globalThis.__DATALAB_V4_NETWORK_BLOCKED__, true);
  assert.throws(() => require("node:https").get("https://example.invalid"), { code: "V4_OFFLINE_NETWORK_BLOCKED" });
  assert.throws(() => fetch("https://example.invalid"), { code: "V4_OFFLINE_NETWORK_BLOCKED" });
  assert.equal(await gitBlobSha(ORIGINAL_COLLECTOR), EXPECTED_COLLECTOR_BLOB);
  assert.equal(sha256(await fsp.readFile(LOCKFILE)), EXPECTED_LOCKFILE_SHA256);

  const signedSchema = JSON.parse(await fsp.readFile(SIGNED_SCHEMA, "utf8"));
  const resultSchema = JSON.parse(await fsp.readFile(RESULT_SCHEMA_FILE, "utf8"));
  assert.equal(signedSchema.properties.purpose.const, PURPOSE);
  assert.equal(signedSchema.properties.requestedCommit.const, CONTRACT_BASELINE_COMMIT);
  assert.equal(signedSchema.properties.collectorBlob.const, EXPECTED_COLLECTOR_BLOB);
  assert.ok(resultSchema.required.includes("exitCode"));

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-fixture-transport-"));
  const passed = [];
  const mark = (name) => passed.push(name);
  try {
    const environmentRoot = path.join(temp, "environment-root");
    assert.equal(validateProducerEnvironment(producerEnvironment(environmentRoot)).keyId, KEY_ID);
    assert.equal(validateSupervisorEnvironment(supervisorEnvironment(environmentRoot)).workerId, "phase9-environment-worker");
    assert.throws(
      () => validateSupervisorEnvironment({ ...supervisorEnvironment(environmentRoot), V4_FIXTURE_WORKER_ID: "../escape" }),
      (error) => error.code === "FIXTURE_IDENTIFIER_INVALID"
    );
    mark("environment-gates");

    const now = Date.now();
    const normalRoots = await newRoots(temp, "normal");
    const normalJob = baseJob("normal");
    const produced = await produceFixtureJob({
      roots: normalRoots,
      root: normalRoots.root,
      job: normalJob,
      keyId: KEY_ID,
      secret: SECRET,
      scenario: "success",
      nonce: "nonce-phase9-normal-0001",
      nowMs: now
    });
    assert.equal(produced.status, "queued");
    let stubInvocations = 0;
    const normalResult = await processNext(normalRoots, supervisorConfig(normalRoots), {
      nowMs: now,
      runParity: async (envelope, roots, claimRecord) => {
        stubInvocations += 1;
        return succeededResult(envelope, claimRecord.claimId, now);
      }
    });
    assert.equal(normalResult.status, "succeeded");
    assert.equal(stubInvocations, 1);
    assert.deepEqual(await getResult(normalRoots, normalJob.idempotencyKey), normalResult);
    const duplicate = await produceFixtureJob({
      roots: normalRoots,
      root: normalRoots.root,
      job: normalJob,
      keyId: KEY_ID,
      secret: SECRET,
      scenario: "success",
      nonce: "nonce-phase9-normal-0002",
      nowMs: now + 1
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.collectorInvocations, 0);
    assert.equal(stubInvocations, 1);
    mark("signed-job-and-idempotent-result-replay");

    const signatureEnvelope = signedJob(baseJob("bad-signature"), { nowMs: now });
    signatureEnvelope.signature = `${signatureEnvelope.signature.slice(0, -1)}${signatureEnvelope.signature.endsWith("0") ? "1" : "0"}`;
    await assertEnqueueRejected(temp, "signature", signatureEnvelope, "FIXTURE_SIGNATURE_INVALID", verifyOptions(now));

    const unknownEnvelope = signedJob(baseJob("unknown-key"), {
      keyId: "unknown-key-v1",
      secret: UNKNOWN_SECRET,
      nowMs: now
    });
    await assertEnqueueRejected(temp, "unknown-key", unknownEnvelope, "FIXTURE_KEY_ID_UNKNOWN", verifyOptions(now));

    const tamperedEnvelope = signedJob(baseJob("tampered"), { nowMs: now });
    tamperedEnvelope.job.keyword = "tampered fixture payload";
    await assertEnqueueRejected(temp, "tampered", tamperedEnvelope, "FIXTURE_PAYLOAD_DIGEST_MISMATCH", verifyOptions(now));

    const policyEnvelope = signedJob(baseJob("payload-policy"), { nowMs: now });
    policyEnvelope.job.keyword = "customer supplied live query";
    policyEnvelope.payloadDigest = sha256(stableJson(policyEnvelope.job));
    const policyRejected = resign(policyEnvelope);
    await assertEnqueueRejected(temp, "payload-policy", policyRejected, "FIXTURE_JOB_POLICY_FORBIDDEN", verifyOptions(now));

    const expiredEnvelope = signedJob(baseJob("expired"), { nowMs: now - 700000, ttlMs: 300000 });
    await assertEnqueueRejected(temp, "expired", expiredEnvelope, "FIXTURE_JOB_EXPIRED", verifyOptions(now));

    const futureEnvelope = signedJob(baseJob("future"), { nowMs: now + 60001 });
    await assertEnqueueRejected(temp, "future", futureEnvelope, "FIXTURE_JOB_FROM_FUTURE", verifyOptions(now));

    const altered = signedJob(baseJob("altered-contract"), { nowMs: now });
    const forbiddenPurpose = resign({ ...altered, purpose: "operational_collection", signature: "" });
    await assertEnqueueRejected(temp, "purpose", forbiddenPurpose, "FIXTURE_PURPOSE_FORBIDDEN", verifyOptions(now));
    const forbiddenScenario = resign({ ...altered, scenario: "live", signature: "" });
    await assertEnqueueRejected(temp, "scenario", forbiddenScenario, "FIXTURE_SCENARIO_FORBIDDEN", verifyOptions(now));
    const wrongCommit = resign({ ...altered, requestedCommit: "0".repeat(40), signature: "" });
    await assertEnqueueRejected(temp, "commit", wrongCommit, "FIXTURE_COMMIT_MISMATCH", verifyOptions(now));
    const wrongBlob = resign({ ...altered, collectorBlob: "0".repeat(40), signature: "" });
    await assertEnqueueRejected(temp, "blob", wrongBlob, "FIXTURE_COLLECTOR_BLOB_MISMATCH", verifyOptions(now));
    mark("invalid-contracts-rejected-before-runner");

    const nonceRoots = await newRoots(temp, "nonce-replay");
    const nonceEnvelope = signedJob(baseJob("nonce-replay"), { nowMs: now, nonce: "nonce-phase9-replay-0001" });
    await enqueue(nonceRoots, nonceEnvelope, verifyOptions(now));
    await assertRejected(enqueue(nonceRoots, nonceEnvelope, verifyOptions(now)), "FIXTURE_NONCE_REPLAY");
    mark("nonce-replay");

    const conflictRoots = await newRoots(temp, "idempotency-conflict");
    const firstConflictJob = baseJob("conflict");
    await enqueue(conflictRoots, signedJob(firstConflictJob, { nowMs: now }), verifyOptions(now));
    const secondConflictJob = { ...firstConflictJob, checkOut: "2026-08-19" };
    await assertRejected(
      enqueue(conflictRoots, signedJob(secondConflictJob, { nowMs: now, nonce: "nonce-phase9-conflict-0002" }), verifyOptions(now)),
      "FIXTURE_IDEMPOTENCY_CONFLICT"
    );
    mark("idempotency-conflict");

    const claimRoots = await newRoots(temp, "concurrent-claim");
    const claimEnvelope = signedJob(baseJob("concurrent-claim"), { nowMs: now });
    await enqueue(claimRoots, claimEnvelope, verifyOptions(now));
    const competingClaims = await Promise.all([
      claim(claimRoots, "phase9-consumer-a", 5000, { nowMs: now }),
      claim(claimRoots, "phase9-consumer-b", 5000, { nowMs: now })
    ]);
    const owned = competingClaims.filter(Boolean);
    assert.equal(owned.length, 1);
    const leaseBefore = await readJson(claimRoots, owned[0].leaseFile);
    const leaseAfter = await heartbeat(claimRoots, owned[0], 5000, { nowMs: now + 1500 });
    assert.ok(Date.parse(leaseAfter.heartbeatAt) > Date.parse(leaseBefore.heartbeatAt));
    await complete(claimRoots, owned[0], succeededResult(owned[0].envelope, owned[0].claimId, now + 1500));
    const lockConfig = supervisorConfig(claimRoots, { workerId: "phase9-lock-owner" });
    const lockHandle = await acquireSupervisorLock(claimRoots, lockConfig, now);
    await assertRejected(acquireSupervisorLock(claimRoots, lockConfig, now + 1), "FIXTURE_SUPERVISOR_ALREADY_RUNNING");
    assert.equal(await releaseSupervisorLock(claimRoots, lockHandle, lockConfig), true);
    mark("single-claim-heartbeat-supervisor-lock");

    const staleRoots = await newRoots(temp, "stale-claim");
    const staleJob = baseJob("stale-claim");
    const staleEnvelope = signedJob(staleJob, { nowMs: now });
    await enqueue(staleRoots, staleEnvelope, verifyOptions(now));
    await claim(staleRoots, "phase9-crashed-worker", 1000, { nowMs: now });
    const recovered = await recoverStaleClaims(staleRoots, verifyOptions(now + 1001), { nowMs: now + 1001 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "failed");
    assert.equal(recovered[0].code, "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY");
    assert.equal(recovered[0].collectorInvocations, 0);
    assert.equal(await claim(staleRoots, "phase9-recovery-worker", 1000, { nowMs: now + 1002 }), null);
    assert.equal((await getResult(staleRoots, staleJob.idempotencyKey)).code, "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY");
    const staleReplay = await enqueue(
      staleRoots,
      signedJob(staleJob, { nowMs: now + 1002, nonce: "nonce-phase9-stale-replay" }),
      verifyOptions(now + 1002)
    );
    assert.equal(staleReplay.status, "duplicate");
    assert.equal(staleReplay.collectorInvocations, 0);
    assert.equal((await jsonFiles(staleRoots.stale)).length, 1);
    mark("stale-claim-quarantine-no-auto-retry");

    const ackRoots = await newRoots(temp, "result-ack-loss");
    const ackJob = baseJob("result-ack-loss");
    const ackEnvelope = signedJob(ackJob, { nowMs: now });
    await enqueue(ackRoots, ackEnvelope, verifyOptions(now));
    const ackClaim = await claim(ackRoots, "phase9-ack-loss-worker", 1000, { nowMs: now });
    const writtenResult = succeededResult(ackEnvelope, ackClaim.claimId, now + 500);
    const orphanedResultFile = path.join(ackRoots.results, `${sha256(ackJob.idempotencyKey)}.json`);
    await writeJsonAtomic(ackRoots.root, orphanedResultFile, writtenResult);
    const reconciled = await recoverStaleClaims(ackRoots, verifyOptions(now + 1001), { nowMs: now + 1001 });
    assert.equal(reconciled.length, 1);
    assert.deepEqual(reconciled[0], writtenResult);
    assert.deepEqual(await getResult(ackRoots, ackJob.idempotencyKey), writtenResult);
    assert.deepEqual(await jsonFiles(ackRoots.claims), []);
    assert.deepEqual(await jsonFiles(ackRoots.leases), []);
    assert.deepEqual(await jsonFiles(ackRoots.stale), []);
    const ackReplay = await enqueue(
      ackRoots,
      signedJob(ackJob, { nowMs: now + 1002, nonce: "nonce-phase9-ack-loss-replay" }),
      verifyOptions(now + 1002)
    );
    assert.equal(ackReplay.status, "duplicate");
    assert.equal(ackReplay.collectorInvocations, 0);
    mark("result-write-ack-loss-reconciliation");

    const partialRoots = await newRoots(temp, "partial-artifact");
    const partialEnvelope = signedJob(baseJob("partial-artifact"), { nowMs: now });
    await enqueue(partialRoots, partialEnvelope, verifyOptions(now));
    const partialResult = await processNext(partialRoots, supervisorConfig(partialRoots), {
      nowMs: now,
      runParity: async () => {
        const partialDirectory = path.join(partialRoots.runs, "isolated-partial-attempt");
        await fsp.mkdir(partialDirectory);
        await fsp.writeFile(path.join(partialDirectory, "partial.json"), "{}\n", "utf8");
        const error = new SupervisorError("FIXTURE_PARTIAL_ARTIFACT", "artifact", "Synthetic partial artifact failure.", {
          collectorInvocations: 1
        });
        error.exitCode = 17;
        throw error;
      }
    });
    assert.equal(partialResult.status, "failed");
    assert.equal(partialResult.code, "FIXTURE_PARTIAL_ARTIFACT");
    assert.equal(partialResult.exitCode, 17);
    assert.equal(partialResult.artifactManifestDigest, null);
    assert.equal((await jsonFiles(partialRoots.queue)).length, 0);
    assert.equal(fs.existsSync(path.join(partialRoots.runs, "isolated-partial-attempt", "partial.json")), true);
    mark("partial-artifact-isolated");

    const shutdownRoots = await newRoots(temp, "shutdown-release");
    const shutdownEnvelope = signedJob(baseJob("shutdown-release"), { nowMs: now });
    await enqueue(shutdownRoots, shutdownEnvelope, verifyOptions(now));
    const controller = new AbortController();
    controller.abort();
    const shutdownResult = await processNext(shutdownRoots, supervisorConfig(shutdownRoots), {
      nowMs: now,
      signal: controller.signal,
      runParity: async () => {
        throw new SupervisorError("FIXTURE_CHILD_ABORTED", "shutdown", "Synthetic shutdown.", {
          retryable: true,
          collectorInvocations: 1
        });
      }
    });
    assert.equal(shutdownResult.code, "FIXTURE_SHUTDOWN_RELEASED");
    assert.equal(shutdownResult.retryable, true);
    assert.equal(await claim(shutdownRoots, "phase9-no-auto-retry", 1000), null);
    mark("shutdown-terminal-without-auto-retry");

    const pathRoots = await newRoots(temp, "path-boundary");
    const outsideFile = path.join(temp, "outside-write.json");
    await assertRejected(writeJsonAtomic(pathRoots.root, outsideFile, { forbidden: true }), "FIXTURE_TRANSPORT_PATH_OUTSIDE_ROOT");
    assert.equal(fs.existsSync(outsideFile), false);
    await assertRejected(initializeFixtureTransport("relative-fixture-root"), "FIXTURE_TRANSPORT_ROOT_INVALID");
    const symlinkRoots = await newRoots(temp, "symlink-boundary");
    const outsideQueue = path.join(temp, "outside-queue");
    await fsp.mkdir(outsideQueue);
    await fsp.rmdir(symlinkRoots.queue);
    await fsp.symlink(outsideQueue, symlinkRoots.queue, process.platform === "win32" ? "junction" : "dir");
    await assertRejected(claim(symlinkRoots, "phase9-symlink-probe", 1000), "FIXTURE_TRANSPORT_SYMLINK_REJECTED");
    mark("path-and-symlink-boundary");

    const cliRoots = await newRoots(temp, "producer-cli");
    const cliJob = baseJob("producer-cli");
    const cliJobFile = path.join(temp, "producer-cli-job.json");
    await fsp.writeFile(cliJobFile, `${JSON.stringify(cliJob, null, 2)}\n`, "utf8");
    const cli = spawnSync(process.execPath, [
      "--require",
      NETWORK_BLOCKER,
      PRODUCER,
      "--job-file",
      cliJobFile,
      "--scenario",
      "success"
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...producerEnvironment(cliRoots.root) }
    });
    assert.equal(cli.status, 0, cli.stderr);
    const cliLines = cli.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(cliLines.length, 1);
    const cliOutput = JSON.parse(cliLines[0]);
    assert.equal(cliOutput.status, "queued");
    const queuedFile = path.join(cliRoots.queue, (await jsonFiles(cliRoots.queue))[0]);
    const queuedRecord = await readJson(cliRoots, queuedFile);
    const queuedSignature = queuedRecord.envelope.signature;
    assert.equal(cli.stdout.includes(SECRET), false);
    assert.equal(cli.stderr.includes(SECRET), false);
    assert.equal(cli.stdout.includes(queuedSignature), false);
    await processNext(cliRoots, supervisorConfig(cliRoots), {
      runParity: async (envelope, roots, claimRecord) => succeededResult(envelope, claimRecord.claimId)
    });
    await assertNoValueInFiles(cliRoots.root, SECRET, "HMAC key");
    await assertNoValueInFiles(cliRoots.root, queuedSignature, "signature");
    mark("one-line-secret-free-producer-output");

    const bootstrapRoots = await newRoots(temp, "shadow-bootstrap");
    const bootstrapConfig = supervisorConfig(bootstrapRoots);
    const bootstrapEnv = {
      V4_FIXTURE_BOOTSTRAP_ENABLED: "1",
      V4_FIXTURE_BOOTSTRAP_JOB_FILE: "tests/fixtures/v4_collector_parity_job.json",
      V4_FIXTURE_BOOTSTRAP_SCENARIO: "success"
    };
    const bootstrap = validateBootstrapEnvironment(bootstrapEnv);
    assert.equal(bootstrap.jobFile, FIXTURE_JOB);
    const firstBootstrap = await bootstrapFixture({ roots: bootstrapRoots, config: bootstrapConfig, bootstrap });
    assert.equal(firstBootstrap.status, "queued");
    let bootstrapInvocations = 0;
    await processNext(bootstrapRoots, bootstrapConfig, {
      runParity: async (envelope, roots, claimRecord) => {
        bootstrapInvocations += 1;
        return succeededResult(envelope, claimRecord.claimId);
      }
    });
    const restartBootstrap = await bootstrapFixture({ roots: bootstrapRoots, config: bootstrapConfig, bootstrap });
    assert.equal(restartBootstrap.status, "duplicate");
    assert.equal(restartBootstrap.collectorInvocations, 0);
    assert.equal(bootstrapInvocations, 1);
    assert.throws(
      () => validateBootstrapEnvironment({ ...bootstrapEnv, V4_FIXTURE_BOOTSTRAP_JOB_FILE: "package.json" }),
      (error) => error.code === "FIXTURE_BOOTSTRAP_JOB_FORBIDDEN"
    );
    mark("same-process-shadow-bootstrap-restart-reuse");

    const actualRoots = await newRoots(temp, "actual-parity-child");
    const actualJob = baseJob("actual-parity-child");
    await enqueue(actualRoots, signedJob(actualJob), verifyOptions());
    let childSpawns = 0;
    const actualResult = await processNext(actualRoots, supervisorConfig(actualRoots), {
      onSpawn: () => { childSpawns += 1; }
    });
    assert.equal(childSpawns, 1);
    assert.equal(actualResult.status, "succeeded");
    assert.equal(actualResult.matched, true);
    assert.equal(actualResult.actualExternalRequests, 0);
    assert.equal(actualResult.operationalWrites, false);
    assert.equal(actualResult.collectorInvocations, 1);
    assert.equal(actualResult.exitCode, 0);
    assert.match(actualResult.artifactManifestDigest, /^[a-f0-9]{64}$/);
    const actualReplay = await enqueue(
      actualRoots,
      signedJob(actualJob, { nonce: "nonce-phase9-actual-replay" }),
      verifyOptions()
    );
    assert.equal(actualReplay.status, "duplicate");
    assert.equal(actualReplay.collectorInvocations, 0);
    assert.equal(childSpawns, 1);
    mark("actual-parity-child-once-network-zero");

    const verified = verifySignedJob(signedJob(baseJob("verification")), verifyOptions());
    assert.equal(verified.requestedCommit, CONTRACT_BASELINE_COMMIT);
    assert.equal(verified.collectorBlob, EXPECTED_COLLECTOR_BLOB);
    mark("baseline-bound-signature");

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "datalab-v4-fixture-transport-test.v1",
      status: "succeeded",
      nodeVersion: process.version,
      checks: passed,
      checkCount: passed.length,
      parityChildSpawns: childSpawns,
      actualExternalRequests: 0,
      operationalWrites: false,
      collectorBlob: EXPECTED_COLLECTOR_BLOB,
      phase9LockfileSha256: PHASE9_LOCKFILE_SHA256,
      lockfileSha256: EXPECTED_LOCKFILE_SHA256
    })}\n`);
  } finally {
    const resolvedTemp = path.resolve(temp);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`)) {
      await fsp.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
