const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  RESULT_SCHEMA,
  normalizeResult,
  resultDigest,
  safeIdentifier,
  sha256,
  stableJson,
  verifySignedJob
} = require("./v4_fixture_job_contract.cjs");

const ROOT_SCHEMA = "datalab-v4-fixture-transport-root.v1";
const QUEUE_SCHEMA = "datalab-v4-fixture-queue-record.v1";
const LEASE_SCHEMA = "datalab-v4-fixture-lease.v1";
const IDEMPOTENCY_SCHEMA = "datalab-v4-fixture-idempotency.v1";
const NONCE_SCHEMA = "datalab-v4-fixture-nonce.v1";
const REJECTION_SCHEMA = "datalab-v4-fixture-rejection.v1";
const STALE_SCHEMA = "datalab-v4-fixture-stale-claim.v1";

class FixtureTransportError extends Error {
  constructor(code, stage, message, options = {}) {
    super(message);
    this.name = "FixtureTransportError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable === true;
  }
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(parent, child) {
  if (!isContained(parent, child)) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_PATH_OUTSIDE_ROOT", "storage", "Path is outside the fixture transport root.");
  }
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectorySafe(root, target) {
  assertContained(root, target);
  const stat = await lstatOrNull(target);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_SYMLINK_REJECTED", "storage", "Transport directory is missing or symbolic.");
  }
}

async function assertRegularFile(root, target) {
  assertContained(root, target);
  const stat = await lstatOrNull(target);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_FILE_INVALID", "storage", "Transport record must be a regular file.");
  }
  return stat;
}

async function writeJsonAtomic(root, filePath, value, replace = false) {
  assertContained(root, filePath);
  await assertDirectorySafe(root, path.dirname(filePath));
  const existing = await lstatOrNull(filePath);
  if (existing?.isSymbolicLink()) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_SYMLINK_REJECTED", "storage", "Refusing to replace a symbolic link.");
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`
  );
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (replace) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fsp.rename(temporary, filePath);
          break;
        } catch (error) {
          if (!['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(error.code) || attempt >= 20) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } else {
      await fsp.link(temporary, filePath);
      await fsp.unlink(temporary);
    }
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readJson(roots, filePath) {
  await assertRegularFile(roots.root, filePath);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_JSON_INVALID", "storage", `Transport JSON is invalid: ${error.code || error.name}.`);
  }
}

async function initializeFixtureTransport(rootValue) {
  if (!path.isAbsolute(String(rootValue || ""))) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_ROOT_INVALID", "storage", "Fixture transport root must be absolute.");
  }
  const root = path.resolve(rootValue);
  await fsp.mkdir(root, { recursive: true });
  const rootStat = await lstatOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FixtureTransportError("FIXTURE_TRANSPORT_ROOT_INVALID", "storage", "Fixture transport root must be a real directory.");
  }
  const roots = {
    root,
    queue: path.join(root, "queue"),
    claims: path.join(root, "claims"),
    leases: path.join(root, "leases"),
    results: path.join(root, "results"),
    rejected: path.join(root, "rejected"),
    stale: path.join(root, "stale"),
    idempotency: path.join(root, "idempotency"),
    nonces: path.join(root, "nonces"),
    locks: path.join(root, "locks"),
    runtime: path.join(root, "runtime"),
    runs: path.join(root, "runs")
  };
  for (const directory of Object.values(roots).filter((value) => value !== root)) {
    assertContained(root, directory);
    await fsp.mkdir(directory, { recursive: true });
    await assertDirectorySafe(root, directory);
  }
  const marker = path.join(root, ".v4-fixture-transport.json");
  const markerStat = await lstatOrNull(marker);
  if (!markerStat) {
    await writeJsonAtomic(root, marker, {
      schemaVersion: ROOT_SCHEMA,
      adapter: "local-filesystem-fixture-only",
      crossServiceSupported: false
    });
  } else {
    const parsed = await readJson(roots, marker);
    if (parsed?.schemaVersion !== ROOT_SCHEMA || parsed.crossServiceSupported !== false) {
      throw new FixtureTransportError("FIXTURE_TRANSPORT_MARKER_INVALID", "storage", "Fixture transport marker is invalid.");
    }
  }
  return roots;
}

function hashedRecordPath(roots, bucket, value, suffix = ".json") {
  const target = path.join(roots[bucket], `${sha256(String(value))}${suffix}`);
  assertContained(roots[bucket], target);
  return target;
}

function entryRecordPath(roots, bucket, entryId, suffix = ".json") {
  const safe = safeIdentifier(entryId, "entryId");
  const target = path.join(roots[bucket], `${safe}${suffix}`);
  assertContained(roots[bucket], target);
  return target;
}

async function withExclusiveLock(roots, name, callback) {
  const lockFile = entryRecordPath(roots, "locks", name, ".lock");
  let handle;
  try {
    handle = await fsp.open(lockFile, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new FixtureTransportError("FIXTURE_TRANSPORT_LOCKED", "transport", "Transport record is currently locked.", { retryable: true });
    }
    throw error;
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(lockFile).catch(() => {});
  }
}

function payloadIdentity(envelope) {
  return sha256(stableJson({
    payloadDigest: envelope.payloadDigest,
    scenario: envelope.scenario,
    requestedCommit: envelope.requestedCommit,
    collectorBlob: envelope.collectorBlob
  }));
}

async function getResult(roots, idempotencyKey) {
  const ledgerFile = hashedRecordPath(roots, "idempotency", idempotencyKey);
  if (!fs.existsSync(ledgerFile)) return null;
  const ledger = await readJson(roots, ledgerFile);
  if (ledger?.schemaVersion !== IDEMPOTENCY_SCHEMA) {
    throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_RECORD_INVALID", "idempotency", "Idempotency record is invalid.");
  }
  if (!["succeeded", "failed"].includes(ledger.status)) return null;
  const resultFile = hashedRecordPath(roots, "results", idempotencyKey);
  if (!fs.existsSync(resultFile)) {
    throw new FixtureTransportError("FIXTURE_RESULT_MISSING", "idempotency", "Terminal idempotency result is missing.");
  }
  const result = normalizeResult(await readJson(roots, resultFile));
  if (resultDigest(result) !== ledger.resultDigest) {
    throw new FixtureTransportError("FIXTURE_RESULT_DIGEST_MISMATCH", "idempotency", "Stored result digest does not match its ledger.");
  }
  return result;
}

async function enqueue(roots, input, verifyOptions) {
  const envelope = verifySignedJob(input, verifyOptions);
  const idempotencyHash = sha256(envelope.idempotencyKey);
  const nonceFile = hashedRecordPath(roots, "nonces", envelope.nonce);
  const ledgerFile = hashedRecordPath(roots, "idempotency", envelope.idempotencyKey);
  const identity = payloadIdentity(envelope);
  const entryId = sha256(`${idempotencyHash}:${identity}`);
  return withExclusiveLock(roots, `${idempotencyHash}.enqueue`, async () => {
    if (fs.existsSync(nonceFile)) {
      throw new FixtureTransportError("FIXTURE_NONCE_REPLAY", "replay", "nonce was already accepted.");
    }
    if (fs.existsSync(ledgerFile)) {
      const ledger = await readJson(roots, ledgerFile);
      if (ledger?.schemaVersion !== IDEMPOTENCY_SCHEMA || ledger.payloadIdentity !== identity) {
        throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_CONFLICT", "idempotency", "Idempotency key is bound to a different payload.");
      }
      if (["succeeded", "failed"].includes(ledger.status)) {
        const result = await getResult(roots, envelope.idempotencyKey);
        return { status: "duplicate", duplicate: true, collectorInvocations: 0, result };
      }
      throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_PENDING", "idempotency", "Idempotency key already has a pending claim.");
    }

    const acceptedAt = new Date(Number.isFinite(verifyOptions?.nowMs) ? verifyOptions.nowMs : Date.now()).toISOString();
    const nonceRecord = { schemaVersion: NONCE_SCHEMA, nonceHash: sha256(envelope.nonce), acceptedAt };
    const ledger = {
      schemaVersion: IDEMPOTENCY_SCHEMA,
      idempotencyKeyHash: idempotencyHash,
      payloadIdentity: identity,
      payloadDigest: envelope.payloadDigest,
      scenario: envelope.scenario,
      jobId: envelope.jobId,
      entryId,
      status: "queued",
      createdAt: acceptedAt,
      resultDigest: null
    };
    const queueRecord = {
      schemaVersion: QUEUE_SCHEMA,
      entryId,
      enqueuedAt: acceptedAt,
      envelope
    };
    const queueFile = entryRecordPath(roots, "queue", entryId);
    let nonceWritten = false;
    let ledgerWritten = false;
    try {
      await writeJsonAtomic(roots.root, nonceFile, nonceRecord);
      nonceWritten = true;
      await writeJsonAtomic(roots.root, ledgerFile, ledger);
      ledgerWritten = true;
      await writeJsonAtomic(roots.root, queueFile, queueRecord);
    } catch (error) {
      if (ledgerWritten) await fsp.unlink(ledgerFile).catch(() => {});
      if (nonceWritten) await fsp.unlink(nonceFile).catch(() => {});
      await fsp.unlink(queueFile).catch(() => {});
      throw error;
    }
    return {
      status: "queued",
      duplicate: false,
      entryId,
      jobId: envelope.jobId,
      idempotencyKeyHash: idempotencyHash,
      scenario: envelope.scenario,
      collectorInvocations: 0
    };
  });
}

async function listRegularJson(roots, bucket) {
  await assertDirectorySafe(roots.root, roots[bucket]);
  const names = (await fsp.readdir(roots[bucket])).filter((name) => name.endsWith(".json")).sort();
  const valid = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      throw new FixtureTransportError("FIXTURE_TRANSPORT_FILENAME_INVALID", "storage", "Transport bucket contains an invalid filename.");
    }
    await assertRegularFile(roots.root, path.join(roots[bucket], name));
    valid.push(name);
  }
  return valid;
}

async function writeLease(roots, claim, workerId, leaseMs, nowMs, replace) {
  const duration = Number(leaseMs);
  if (!Number.isInteger(duration) || duration < 250 || duration > 10 * 60 * 1000) {
    throw new FixtureTransportError("FIXTURE_LEASE_INVALID", "lease", "leaseMs is outside the allowed range.");
  }
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const lease = {
    schemaVersion: LEASE_SCHEMA,
    entryId: claim.entryId,
    claimId: claim.claimId,
    workerId: safeIdentifier(workerId, "workerId"),
    claimedAt: claim.claimedAt,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + duration).toISOString()
  };
  await writeJsonAtomic(roots.root, claim.leaseFile, lease, replace);
  return lease;
}

async function claim(roots, workerId, leaseMs, options = {}) {
  const owner = safeIdentifier(workerId, "workerId");
  for (const file of await listRegularJson(roots, "queue")) {
    const entryId = file.slice(0, -5);
    const queueFile = entryRecordPath(roots, "queue", entryId);
    const claimFile = entryRecordPath(roots, "claims", entryId);
    try {
      const claimed = await withExclusiveLock(roots, `${entryId}.claim`, async () => {
        if (!fs.existsSync(queueFile) || fs.existsSync(claimFile)) return null;
        const record = await readJson(roots, queueFile);
        if (record?.schemaVersion !== QUEUE_SCHEMA || record.entryId !== entryId || !record.envelope) {
          throw new FixtureTransportError("FIXTURE_QUEUE_RECORD_INVALID", "claim", "Queued fixture record is invalid.");
        }
        await fsp.rename(queueFile, claimFile);
        const now = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
        const claimRecord = {
          entryId,
          envelope: record.envelope,
          claimFile,
          claimId: crypto.randomBytes(16).toString("hex"),
          workerId: owner,
          claimedAt: new Date(now).toISOString(),
          leaseFile: entryRecordPath(roots, "leases", entryId)
        };
        await writeLease(roots, claimRecord, owner, leaseMs, now, false);
        return claimRecord;
      });
      if (claimed) return claimed;
    } catch (error) {
      if (error.code === "FIXTURE_TRANSPORT_LOCKED" || error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

async function heartbeat(roots, claimRecord, leaseMs, options = {}) {
  const lease = await readJson(roots, claimRecord.leaseFile);
  if (
    lease?.schemaVersion !== LEASE_SCHEMA
    || lease.entryId !== claimRecord.entryId
    || lease.claimId !== claimRecord.claimId
    || lease.workerId !== claimRecord.workerId
  ) {
    throw new FixtureTransportError("FIXTURE_LEASE_OWNERSHIP_LOST", "lease", "Lease ownership no longer matches this claim.");
  }
  return writeLease(
    roots,
    claimRecord,
    claimRecord.workerId,
    leaseMs,
    Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now(),
    true
  );
}

async function finalize(roots, claimRecord, resultInput) {
  const result = normalizeResult(resultInput);
  if (result.jobId !== claimRecord.envelope.jobId || result.idempotencyKey !== claimRecord.envelope.idempotencyKey) {
    throw new FixtureTransportError("FIXTURE_RESULT_IDENTITY_MISMATCH", "result", "Result identity does not match the claim.");
  }
  const ledgerFile = hashedRecordPath(roots, "idempotency", result.idempotencyKey);
  if (!fs.existsSync(ledgerFile)) {
    throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_RECORD_MISSING", "idempotency", "Claim has no idempotency ledger.");
  }
  const ledger = await readJson(roots, ledgerFile);
  if (ledger?.schemaVersion !== IDEMPOTENCY_SCHEMA || ledger.entryId !== claimRecord.entryId) {
    throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_RECORD_INVALID", "idempotency", "Claim ledger is invalid.");
  }
  const digest = resultDigest(result);
  const resultFile = hashedRecordPath(roots, "results", result.idempotencyKey);
  if (fs.existsSync(resultFile)) {
    const existing = normalizeResult(await readJson(roots, resultFile));
    if (resultDigest(existing) !== digest) {
      throw new FixtureTransportError("FIXTURE_RESULT_CONFLICT", "result", "A different terminal result already exists.");
    }
  } else {
    await writeJsonAtomic(roots.root, resultFile, result);
  }
  const completedLedger = {
    ...ledger,
    status: result.status === "succeeded" ? "succeeded" : "failed",
    completedAt: result.completedAt,
    resultDigest: digest
  };
  await writeJsonAtomic(roots.root, ledgerFile, completedLedger, true);
  await fsp.unlink(claimRecord.leaseFile).catch(() => {});
  await fsp.unlink(claimRecord.claimFile).catch(() => {});
  return result;
}

async function complete(roots, claimRecord, result) {
  if (result?.status !== "succeeded") {
    throw new FixtureTransportError("FIXTURE_COMPLETE_STATUS_INVALID", "result", "complete requires a succeeded result.");
  }
  return finalize(roots, claimRecord, result);
}

async function fail(roots, claimRecord, result) {
  if (result?.status !== "failed") {
    throw new FixtureTransportError("FIXTURE_FAIL_STATUS_INVALID", "result", "fail requires a failed result.");
  }
  return finalize(roots, claimRecord, result);
}

async function reconcileExistingResult(roots, claimRecord) {
  const envelope = claimRecord.envelope;
  if (!envelope?.idempotencyKey || !envelope?.jobId) return null;
  const resultFile = hashedRecordPath(roots, "results", envelope.idempotencyKey);
  if (!fs.existsSync(resultFile)) return null;
  const result = normalizeResult(await readJson(roots, resultFile));
  if (
    !["succeeded", "failed"].includes(result.status)
    || result.jobId !== envelope.jobId
    || result.idempotencyKey !== envelope.idempotencyKey
  ) {
    throw new FixtureTransportError("FIXTURE_RESULT_IDENTITY_MISMATCH", "recovery", "Stored result does not match its stale claim.");
  }
  const ledgerFile = hashedRecordPath(roots, "idempotency", envelope.idempotencyKey);
  const ledger = await readJson(roots, ledgerFile);
  if (ledger?.schemaVersion !== IDEMPOTENCY_SCHEMA || ledger.entryId !== claimRecord.entryId) {
    throw new FixtureTransportError("FIXTURE_IDEMPOTENCY_RECORD_INVALID", "recovery", "Stored result ledger does not match its stale claim.");
  }
  await writeJsonAtomic(roots.root, ledgerFile, {
    ...ledger,
    status: result.status,
    completedAt: result.completedAt,
    resultDigest: resultDigest(result)
  }, true);
  await fsp.unlink(claimRecord.leaseFile).catch(() => {});
  await fsp.unlink(claimRecord.claimFile).catch(() => {});
  return result;
}

function safeUntrustedIdentifier(value) {
  const text = String(value || "");
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(text) ? text : "unknown";
}

async function rejectClaim(roots, claimRecord, error) {
  const rejectedAt = new Date().toISOString();
  const rejection = {
    schemaVersion: REJECTION_SCHEMA,
    entryId: claimRecord.entryId,
    jobId: safeUntrustedIdentifier(claimRecord.envelope?.jobId),
    status: "rejected",
    stage: safeUntrustedIdentifier(error?.stage || "contract"),
    code: safeUntrustedIdentifier(error?.code || "FIXTURE_JOB_REJECTED"),
    collectorInvocations: 0,
    rejectedAt
  };
  const target = entryRecordPath(roots, "rejected", claimRecord.entryId);
  if (!fs.existsSync(target)) await writeJsonAtomic(roots.root, target, rejection);
  await fsp.unlink(claimRecord.leaseFile).catch(() => {});
  await fsp.unlink(claimRecord.claimFile).catch(() => {});
  return rejection;
}

function failedResult(envelope, claimRecord, code, stage, startedAt, options = {}) {
  const completedAt = new Date(Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()).toISOString();
  return normalizeResult({
    schemaVersion: RESULT_SCHEMA,
    jobId: envelope.jobId,
    idempotencyKey: envelope.idempotencyKey,
    attemptId: options.attemptId || claimRecord.claimId,
    status: "failed",
    stage,
    code,
    matched: false,
    actualExternalRequests: 0,
    operationalWrites: false,
    collectorInvocations: Number.isInteger(options.collectorInvocations) ? options.collectorInvocations : 0,
    exitCode: Number.isInteger(options.exitCode) ? options.exitCode : null,
    artifactManifestDigest: null,
    startedAt,
    completedAt,
    retryable: options.retryable === true,
    scenario: envelope.scenario
  });
}

async function releaseOnShutdown(roots, claimRecord, envelope, options = {}) {
  const result = failedResult(
    envelope,
    claimRecord,
    "FIXTURE_SHUTDOWN_RELEASED",
    "shutdown",
    options.startedAt || claimRecord.claimedAt,
    { ...options, retryable: true }
  );
  return fail(roots, claimRecord, result);
}

async function recoverStaleClaims(roots, verifyOptions = {}, options = {}) {
  const recovered = [];
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  for (const file of await listRegularJson(roots, "claims")) {
    const entryId = file.slice(0, -5);
    const claimFile = entryRecordPath(roots, "claims", entryId);
    const leaseFile = entryRecordPath(roots, "leases", entryId);
    let lease = null;
    if (fs.existsSync(leaseFile)) lease = await readJson(roots, leaseFile).catch(() => null);
    const expiresAt = Date.parse(String(lease?.expiresAt || ""));
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) continue;
    const record = await readJson(roots, claimFile).catch(() => null);
    const claimRecord = {
      entryId,
      envelope: record?.envelope || null,
      claimFile,
      claimId: safeUntrustedIdentifier(lease?.claimId) === "unknown" ? `stale-${entryId.slice(0, 16)}` : lease.claimId,
      workerId: safeUntrustedIdentifier(lease?.workerId),
      claimedAt: Number.isFinite(Date.parse(String(lease?.claimedAt || ""))) ? lease.claimedAt : new Date(nowMs).toISOString(),
      leaseFile
    };
    const existingResult = await reconcileExistingResult(roots, claimRecord);
    if (existingResult) {
      recovered.push(existingResult);
      continue;
    }
    const staleRecord = {
      schemaVersion: STALE_SCHEMA,
      entryId,
      status: "quarantined",
      code: "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY",
      retryable: true,
      collectorInvocations: 0,
      quarantinedAt: new Date(nowMs).toISOString()
    };
    const staleFile = entryRecordPath(roots, "stale", entryId);
    if (!fs.existsSync(staleFile)) await writeJsonAtomic(roots.root, staleFile, staleRecord);
    try {
      const envelope = verifySignedJob(claimRecord.envelope, { ...verifyOptions, nowMs });
      const result = failedResult(
        envelope,
        claimRecord,
        "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY",
        "lease",
        claimRecord.claimedAt,
        { nowMs, retryable: true }
      );
      await fail(roots, claimRecord, result);
      recovered.push(result);
    } catch (error) {
      recovered.push(await rejectClaim(roots, claimRecord, error));
    }
  }
  return recovered;
}

module.exports = {
  IDEMPOTENCY_SCHEMA,
  LEASE_SCHEMA,
  NONCE_SCHEMA,
  QUEUE_SCHEMA,
  REJECTION_SCHEMA,
  ROOT_SCHEMA,
  STALE_SCHEMA,
  FixtureTransportError,
  claim,
  complete,
  enqueue,
  fail,
  getResult,
  heartbeat,
  initializeFixtureTransport,
  readJson,
  recoverStaleClaims,
  rejectClaim,
  releaseOnShutdown,
  writeJsonAtomic
};
