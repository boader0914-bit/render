const {
  claim,
  complete,
  enqueue,
  fail,
  getResult,
  heartbeat,
  recoverStaleClaims,
  rejectClaim,
  releaseOnShutdown
} = require("./v4_fixture_transport_fs.cjs");

const TRANSPORT_INTERFACE_VERSION = "datalab-v4-transport.v1";
const TRANSPORT_METHODS = Object.freeze([
  "enqueue",
  "claim",
  "heartbeat",
  "complete",
  "fail",
  "getResult",
  "releaseOnShutdown",
  "close"
]);

class TransportInterfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransportInterfaceError";
    this.code = code;
    this.stage = "transport";
    this.retryable = false;
  }
}

function assertTransportInterface(transport) {
  if (!transport || typeof transport !== "object") {
    throw new TransportInterfaceError("FIXTURE_TRANSPORT_INTERFACE_INVALID", "Transport must be an object.");
  }
  for (const method of TRANSPORT_METHODS) {
    if (typeof transport[method] !== "function") {
      throw new TransportInterfaceError("FIXTURE_TRANSPORT_INTERFACE_INVALID", `Transport method ${method} is missing.`);
    }
  }
  return transport;
}

function createFilesystemTransport(roots, options = {}) {
  const active = new Map();
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new TransportInterfaceError("FIXTURE_TRANSPORT_CLOSED", "Filesystem transport is closed.");
  };
  const claimFor = (claimId) => {
    const record = active.get(String(claimId));
    if (!record) throw new TransportInterfaceError("FIXTURE_CLAIM_UNKNOWN", "Claim is not owned by this transport instance.");
    return record;
  };
  const verification = (overrides = {}) => ({ ...options.verifyOptions, ...overrides });

  return assertTransportInterface({
    interfaceVersion: TRANSPORT_INTERFACE_VERSION,
    adapter: "local-filesystem-fixture-only",
    crossServiceSupported: false,
    roots,
    async enqueue(job, enqueueOptions = {}) {
      ensureOpen();
      return enqueue(roots, job, verification(enqueueOptions));
    },
    async claim(workerId, leaseMs, claimOptions = {}) {
      ensureOpen();
      const record = await claim(roots, workerId, leaseMs, claimOptions);
      if (record) active.set(record.claimId, { ...record, leaseMs });
      return record;
    },
    async heartbeat(claimId, heartbeatOptions = {}) {
      ensureOpen();
      const record = claimFor(claimId);
      return heartbeat(roots, record, record.leaseMs, heartbeatOptions);
    },
    async complete(claimId, result) {
      ensureOpen();
      const record = claimFor(claimId);
      const terminal = await complete(roots, record, result);
      active.delete(record.claimId);
      return terminal;
    },
    async fail(claimId, result) {
      ensureOpen();
      const record = claimFor(claimId);
      const terminal = await fail(roots, record, result);
      active.delete(record.claimId);
      return terminal;
    },
    async getResult(idempotencyKey) {
      ensureOpen();
      return getResult(roots, idempotencyKey);
    },
    async releaseOnShutdown(claimId, releaseOptions = {}) {
      ensureOpen();
      const record = claimFor(claimId);
      const terminal = await releaseOnShutdown(roots, record, record.envelope, releaseOptions);
      active.delete(record.claimId);
      return terminal;
    },
    async close() {
      closed = true;
      active.clear();
    },
    async reject(claimId, error) {
      ensureOpen();
      const record = claimFor(claimId);
      const rejection = await rejectClaim(roots, record, error);
      active.delete(record.claimId);
      return rejection;
    },
    async recoverStaleClaims(recoverOptions = {}, runtimeOptions = {}) {
      ensureOpen();
      return recoverStaleClaims(roots, verification(recoverOptions), runtimeOptions);
    }
  });
}

module.exports = {
  TRANSPORT_INTERFACE_VERSION,
  TRANSPORT_METHODS,
  TransportInterfaceError,
  assertTransportInterface,
  createFilesystemTransport
};
