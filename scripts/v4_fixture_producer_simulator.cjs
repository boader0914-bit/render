const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  DEFAULT_TTL_MS,
  sha256,
  signJob
} = require("./v4_fixture_job_contract.cjs");
const {
  enqueue,
  initializeFixtureTransport
} = require("./v4_fixture_transport_fs.cjs");

const PRODUCER_SCHEMA = "datalab-v4-fixture-producer-result.v1";
const MAX_JOB_BYTES = 64 * 1024;
const DISABLED_GATES = [
  "V4_FIXTURE_EXTERNAL_CALLS_ENABLED",
  "V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED",
  "V4_FIXTURE_WEB_IMPORT_ENABLED"
];

class ProducerError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.name = "ProducerError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
  }
}

function validateProducerEnvironment(env = process.env) {
  if (env.NODE_ENV !== "test" || env.V4_FIXTURE_TRANSPORT_MODE !== "fixture") {
    throw new ProducerError("FIXTURE_PRODUCER_MODE_INVALID", "environment", "Producer simulator requires test fixture mode.");
  }
  for (const name of DISABLED_GATES) {
    if (env[name] !== "0") {
      throw new ProducerError("FIXTURE_PRODUCER_GATE_NOT_DISABLED", "environment", `${name} must be exactly 0.`);
    }
  }
  if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new ProducerError("FIXTURE_PRODUCER_NETWORK_BLOCKER_REQUIRED", "environment", "Producer simulator requires the network blocker preload.");
  }
  const root = String(env.V4_FIXTURE_TRANSPORT_ROOT || "");
  if (!path.isAbsolute(root)) {
    throw new ProducerError("FIXTURE_PRODUCER_ROOT_INVALID", "environment", "V4_FIXTURE_TRANSPORT_ROOT must be absolute.");
  }
  const keyId = String(env.V4_FIXTURE_JOB_KEY_ID || "").trim();
  const secret = String(env.V4_FIXTURE_JOB_HMAC_KEY || "");
  if (!keyId || !secret) {
    throw new ProducerError("FIXTURE_PRODUCER_SIGNING_CONFIG_MISSING", "environment", "Fixture signing configuration is missing.");
  }
  return { root: path.resolve(root), keyId, secret };
}

async function readJobFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (error) {
    throw new ProducerError("FIXTURE_PRODUCER_JOB_NOT_FOUND", "input", `Fixture job file is unavailable: ${error.code || error.name}.`);
  }
  if (!stat.isFile() || stat.size > MAX_JOB_BYTES) {
    throw new ProducerError("FIXTURE_PRODUCER_JOB_INVALID", "input", "Fixture job file is invalid or too large.");
  }
  try {
    return JSON.parse(await fsp.readFile(resolved, "utf8"));
  } catch (error) {
    throw new ProducerError("FIXTURE_PRODUCER_JOB_INVALID", "input", "Fixture job is not valid JSON.");
  }
}

async function produceFixtureJob(options) {
  const signed = signJob(options.job, {
    keyId: options.keyId,
    secret: options.secret,
    scenario: options.scenario,
    nowMs: options.nowMs,
    ttlMs: options.ttlMs,
    nonce: options.nonce,
    purpose: options.purpose,
    requestedCommit: options.requestedCommit,
    collectorBlob: options.collectorBlob
  });
  const roots = options.roots || await initializeFixtureTransport(options.root);
  const accepted = await enqueue(roots, signed, {
    nowMs: options.nowMs,
    resolveKey: (keyId) => keyId === options.keyId ? options.secret : null
  });
  return {
    schemaVersion: PRODUCER_SCHEMA,
    status: accepted.status,
    jobId: signed.jobId,
    idempotencyKeyHash: sha256(signed.idempotencyKey),
    scenario: signed.scenario,
    duplicate: accepted.duplicate === true,
    collectorInvocations: accepted.collectorInvocations,
    resultStatus: accepted.result?.status || null
  };
}

function parseArgs(argv) {
  const args = { jobFile: "", scenario: "success", ttlMs: DEFAULT_TTL_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-file") args.jobFile = argv[++index] || "";
    else if (token.startsWith("--job-file=")) args.jobFile = token.slice("--job-file=".length);
    else if (token === "--scenario") args.scenario = argv[++index] || "";
    else if (token.startsWith("--scenario=")) args.scenario = token.slice("--scenario=".length);
    else if (token === "--ttl-ms") args.ttlMs = Number(argv[++index]);
    else if (token.startsWith("--ttl-ms=")) args.ttlMs = Number(token.slice("--ttl-ms=".length));
    else throw new ProducerError("FIXTURE_PRODUCER_ARGUMENT_INVALID", "input", `Unknown argument: ${token}`);
  }
  if (!args.jobFile) throw new ProducerError("FIXTURE_PRODUCER_JOB_REQUIRED", "input", "--job-file is required.");
  return args;
}

async function main() {
  let output;
  try {
    const config = validateProducerEnvironment();
    const args = parseArgs(process.argv.slice(2));
    const job = await readJobFile(args.jobFile);
    output = await produceFixtureJob({ ...config, job, scenario: args.scenario, ttlMs: args.ttlMs });
  } catch (error) {
    output = {
      schemaVersion: PRODUCER_SCHEMA,
      status: "failed",
      code: /^[A-Z0-9_]{2,100}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_PRODUCER_FAILED",
      stage: /^[a-z0-9_.:-]{2,100}$/i.test(String(error?.stage || "")) ? error.stage : "producer",
      retryable: false,
      collectorInvocations: 0
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  DISABLED_GATES,
  PRODUCER_SCHEMA,
  ProducerError,
  parseArgs,
  produceFixtureJob,
  readJobFile,
  validateProducerEnvironment
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schemaVersion: PRODUCER_SCHEMA, status: "failed", code: "FIXTURE_PRODUCER_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
