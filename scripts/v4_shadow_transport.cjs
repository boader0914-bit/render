const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const TRANSPORT_SCHEMA = "datalab-v4-shadow-transport-job.v1";
const TERMINAL_SCHEMA = "datalab-v4-shadow-transport-result.v1";
const LEASE_SCHEMA = "datalab-v4-shadow-lease.v1";
const TRANSPORT_MARKER_SCHEMA = "datalab-v4-shadow-transport-root.v1";
const FIXTURE_SCENARIOS = new Set(["success", "slow", "exit", "partial", "missing-file", "manifest-outside"]);
const ENVELOPE_FIELDS = new Set(["schemaVersion", "transportId", "fixtureScenario", "job"]);

class TransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

function safeFileId(value, field = "identifier") {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(text)) {
    throw new TransportError("TRANSPORT_IDENTIFIER_INVALID", `${field} is invalid.`);
  }
  return text;
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(parent, child) {
  if (!isContained(parent, child)) {
    throw new TransportError("TRANSPORT_PATH_INVALID", "Transport path is outside the dedicated worker root.");
  }
}

async function writeJsonAtomic(filePath, value, replace = false) {
  const directory = path.dirname(filePath);
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (replace) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fsp.rename(temp, filePath);
          break;
        } catch (error) {
          if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error.code) || attempt >= 20) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } else {
      await fsp.link(temp, filePath);
      await fsp.unlink(temp);
    }
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

function normalizeEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TransportError("TRANSPORT_ENVELOPE_INVALID", "Transport envelope must be a JSON object.");
  }
  const unknown = Object.keys(input).filter((key) => !ENVELOPE_FIELDS.has(key));
  if (unknown.length) {
    throw new TransportError("TRANSPORT_ENVELOPE_INVALID", `Unknown transport field: ${unknown.sort()[0]}`);
  }
  if (input.schemaVersion !== TRANSPORT_SCHEMA) {
    throw new TransportError("TRANSPORT_SCHEMA_INVALID", `schemaVersion must be ${TRANSPORT_SCHEMA}.`);
  }
  const fixtureScenario = String(input.fixtureScenario || "success");
  if (!FIXTURE_SCENARIOS.has(fixtureScenario)) {
    throw new TransportError("TRANSPORT_FIXTURE_INVALID", "fixtureScenario is not allowed.");
  }
  if (!input.job || typeof input.job !== "object" || Array.isArray(input.job)) {
    throw new TransportError("TRANSPORT_JOB_INVALID", "job must be a JSON object.");
  }
  return {
    schemaVersion: TRANSPORT_SCHEMA,
    transportId: safeFileId(input.transportId, "transportId"),
    fixtureScenario,
    job: input.job
  };
}

async function initializeTransport(workerRoots) {
  if (!workerRoots?.root || !path.isAbsolute(workerRoots.root)) {
    throw new TransportError("TRANSPORT_ROOT_INVALID", "A validated worker root is required.");
  }
  const base = path.join(workerRoots.root, "shadow-transport");
  assertContained(workerRoots.root, base);
  const roots = {
    base,
    inbox: path.join(base, "inbox"),
    claimed: path.join(base, "claimed"),
    leases: path.join(base, "leases"),
    completed: path.join(base, "completed"),
    failed: path.join(base, "failed"),
    locks: path.join(base, "locks"),
    runtime: path.join(base, "runtime")
  };
  for (const directory of Object.values(roots)) {
    assertContained(workerRoots.root, directory);
    await fsp.mkdir(directory, { recursive: true });
  }
  const marker = path.join(base, ".v4-shadow-transport.json");
  if (!fs.existsSync(marker)) {
    await writeJsonAtomic(marker, { schemaVersion: TRANSPORT_MARKER_SCHEMA });
  } else {
    const parsed = await readJson(marker).catch(() => null);
    if (parsed?.schemaVersion !== TRANSPORT_MARKER_SCHEMA) {
      throw new TransportError("TRANSPORT_MARKER_INVALID", "Shadow transport marker is invalid.");
    }
  }
  return roots;
}

function recordPath(roots, bucket, transportId) {
  const target = path.join(roots[bucket], `${safeFileId(transportId, "transportId")}.json`);
  assertContained(roots[bucket], target);
  return target;
}

async function recordExists(roots, transportId) {
  for (const bucket of ["inbox", "claimed", "completed", "failed"]) {
    if (fs.existsSync(recordPath(roots, bucket, transportId))) return true;
  }
  return false;
}

async function enqueueFixture(roots, input) {
  const envelope = normalizeEnvelope(input);
  const enqueueLock = path.join(roots.locks, `${envelope.transportId}.enqueue.lock`);
  let lockHandle;
  try {
    lockHandle = await fsp.open(enqueueLock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new TransportError("TRANSPORT_DUPLICATE", "transportId is already being enqueued.");
    }
    throw error;
  }
  try {
    if (await recordExists(roots, envelope.transportId)) {
      throw new TransportError("TRANSPORT_DUPLICATE", "transportId already exists.");
    }
    const stored = { ...envelope, enqueuedAt: new Date().toISOString() };
    await writeJsonAtomic(recordPath(roots, "inbox", envelope.transportId), stored);
    return stored;
  } finally {
    await lockHandle.close().catch(() => {});
    await fsp.unlink(enqueueLock).catch(() => {});
  }
}

async function writeTerminalRecord(roots, bucket, transportId, value) {
  const target = recordPath(roots, bucket, transportId);
  if (fs.existsSync(target)) return readJson(target);
  await writeJsonAtomic(target, value);
  return value;
}

async function archiveInvalidClaim(roots, claimFile, transportId, code) {
  const now = new Date().toISOString();
  await writeTerminalRecord(roots, "failed", transportId, {
    schemaVersion: TERMINAL_SCHEMA,
    transportId,
    status: "failed",
    code,
    retryable: false,
    completedAt: now
  });
  await fsp.unlink(claimFile).catch(() => {});
}

async function claimNext(roots, workerId, leaseMs) {
  const owner = safeFileId(workerId, "workerId");
  const files = (await fsp.readdir(roots.inbox)).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.json$/.test(name)).sort();
  for (const file of files) {
    const transportId = file.slice(0, -5);
    const inboxFile = recordPath(roots, "inbox", transportId);
    const claimFile = recordPath(roots, "claimed", transportId);
    try {
      await fsp.link(inboxFile, claimFile);
      try {
        await fsp.unlink(inboxFile);
      } catch (error) {
        await fsp.unlink(claimFile).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EEXIST") continue;
      throw error;
    }
    let stored;
    try {
      stored = await readJson(claimFile);
      const unknown = Object.keys(stored || {}).filter((key) => !ENVELOPE_FIELDS.has(key) && key !== "enqueuedAt");
      if (unknown.length) throw new TransportError("TRANSPORT_ENVELOPE_INVALID", "Stored transport envelope has unknown fields.");
      const envelope = normalizeEnvelope({
        schemaVersion: stored?.schemaVersion,
        transportId: stored?.transportId,
        fixtureScenario: stored?.fixtureScenario,
        job: stored?.job
      });
      if (stored.enqueuedAt && typeof stored.enqueuedAt !== "string") {
        throw new TransportError("TRANSPORT_ENVELOPE_INVALID", "enqueuedAt is invalid.");
      }
      const claimedAt = new Date().toISOString();
      const claim = { envelope: { ...envelope, enqueuedAt: stored.enqueuedAt || null }, claimFile, claimedAt };
      await renewLease(roots, claim, owner, leaseMs, true);
      return claim;
    } catch (error) {
      await archiveInvalidClaim(roots, claimFile, transportId, error.code || "TRANSPORT_ENVELOPE_INVALID");
    }
  }
  return null;
}

async function renewLease(roots, claim, workerId, leaseMs, create = false) {
  const duration = Number(leaseMs);
  if (!Number.isInteger(duration) || duration < 250) {
    throw new TransportError("TRANSPORT_LEASE_INVALID", "leaseMs is invalid.");
  }
  const now = Date.now();
  const lease = {
    schemaVersion: LEASE_SCHEMA,
    transportId: claim.envelope.transportId,
    workerId: safeFileId(workerId, "workerId"),
    pid: process.pid,
    claimedAt: claim.claimedAt,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + duration).toISOString()
  };
  const leaseFile = recordPath(roots, "leases", claim.envelope.transportId);
  await writeJsonAtomic(leaseFile, lease, !create);
  claim.leaseFile = leaseFile;
  return lease;
}

async function finishClaim(roots, claim, status, result) {
  const succeeded = status === "completed";
  const bucket = succeeded ? "completed" : "failed";
  const record = {
    schemaVersion: TERMINAL_SCHEMA,
    transportId: claim.envelope.transportId,
    jobId: typeof claim.envelope.job?.jobId === "string" ? claim.envelope.job.jobId : "",
    status: succeeded ? "completed" : "failed",
    code: String(result?.code || (succeeded ? "OK" : "SHADOW_JOB_FAILED")),
    retryable: false,
    fixtureScenario: claim.envelope.fixtureScenario,
    claimedAt: claim.claimedAt,
    completedAt: new Date().toISOString(),
    result: result && typeof result === "object" ? result : null
  };
  await writeTerminalRecord(roots, bucket, claim.envelope.transportId, record);
  await fsp.unlink(claim.leaseFile || recordPath(roots, "leases", claim.envelope.transportId)).catch(() => {});
  await fsp.unlink(claim.claimFile).catch(() => {});
  await fsp.unlink(recordPath(roots, "inbox", claim.envelope.transportId)).catch(() => {});
  return record;
}

async function recoverClaimsWithoutRetry(roots) {
  const recovered = [];
  const files = (await fsp.readdir(roots.claimed)).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const transportId = safeFileId(file.slice(0, -5), "transportId");
    const claimFile = recordPath(roots, "claimed", transportId);
    if (fs.existsSync(recordPath(roots, "completed", transportId)) || fs.existsSync(recordPath(roots, "failed", transportId))) {
      await fsp.unlink(recordPath(roots, "leases", transportId)).catch(() => {});
      await fsp.unlink(claimFile).catch(() => {});
      await fsp.unlink(recordPath(roots, "inbox", transportId)).catch(() => {});
      continue;
    }
    let stored = null;
    try {
      stored = await readJson(claimFile);
    } catch {}
    const record = {
      schemaVersion: TERMINAL_SCHEMA,
      transportId,
      jobId: typeof stored?.job?.jobId === "string" ? stored.job.jobId : "",
      status: "failed",
      code: "LEASE_RECOVERY_NO_RETRY",
      retryable: false,
      completedAt: new Date().toISOString(),
      result: {
        status: "failed",
        code: "LEASE_RECOVERY_NO_RETRY",
        stage: "lease",
        retryable: false
      }
    };
    await writeTerminalRecord(roots, "failed", transportId, record);
    await fsp.unlink(recordPath(roots, "leases", transportId)).catch(() => {});
    await fsp.unlink(claimFile).catch(() => {});
    await fsp.unlink(recordPath(roots, "inbox", transportId)).catch(() => {});
    recovered.push(record);
  }
  return recovered;
}

module.exports = {
  FIXTURE_SCENARIOS,
  LEASE_SCHEMA,
  TERMINAL_SCHEMA,
  TRANSPORT_SCHEMA,
  TransportError,
  claimNext,
  enqueueFixture,
  finishClaim,
  initializeTransport,
  normalizeEnvelope,
  readJson,
  recordPath,
  recoverClaimsWithoutRetry,
  renewLease,
  safeFileId,
  writeJsonAtomic
};
