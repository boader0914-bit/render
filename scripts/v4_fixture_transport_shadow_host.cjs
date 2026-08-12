const path = require("node:path");
const crypto = require("node:crypto");
const {
  produceFixtureJob,
  readJobFile
} = require("./v4_fixture_producer_simulator.cjs");
const {
  initializeFixtureTransport
} = require("./v4_fixture_transport_fs.cjs");
const {
  main: runSupervisor,
  validateSupervisorEnvironment
} = require("./v4_fixture_transport_supervisor.cjs");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_JOB = path.join(ROOT, "tests", "fixtures", "v4_collector_parity_job.json");
const HOST_SCHEMA = "datalab-v4-fixture-transport-shadow-host.v1";

class ShadowHostError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.name = "ShadowHostError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
  }
}

function validateBootstrapEnvironment(env = process.env) {
  if (env.V4_FIXTURE_BOOTSTRAP_ENABLED !== "1") {
    throw new ShadowHostError("FIXTURE_BOOTSTRAP_DISABLED", "environment", "Fixture bootstrap must be explicitly enabled.");
  }
  const configured = path.resolve(ROOT, String(env.V4_FIXTURE_BOOTSTRAP_JOB_FILE || ""));
  if (configured !== FIXTURE_JOB) {
    throw new ShadowHostError("FIXTURE_BOOTSTRAP_JOB_FORBIDDEN", "environment", "Only the committed parity fixture job is allowed.");
  }
  const scenario = String(env.V4_FIXTURE_BOOTSTRAP_SCENARIO || "success");
  return { jobFile: configured, scenario };
}

async function bootstrapFixture(options) {
  const bootstrap = options.bootstrap || validateBootstrapEnvironment(options.env);
  const job = await readJobFile(bootstrap.jobFile);
  try {
    return await produceFixtureJob({
      roots: options.roots,
      root: options.roots.root,
      transport: options.transport,
      job,
      keyId: options.config.keyId,
      secret: options.config.secret,
      scenario: bootstrap.scenario,
      nonce: `bootstrap-${job.jobId}-${crypto.randomBytes(12).toString("hex")}`
    });
  } catch (error) {
    if (error?.code === "FIXTURE_IDEMPOTENCY_PENDING") {
      return {
        schemaVersion: HOST_SCHEMA,
        status: "pending",
        collectorInvocations: 0
      };
    }
    throw error;
  }
}

async function main() {
  const config = validateSupervisorEnvironment();
  const bootstrap = validateBootstrapEnvironment();
  const roots = await initializeFixtureTransport(config.transportRoot);
  return runSupervisor({
    config,
    roots,
    beforeReady: () => bootstrapFixture({ roots, config, bootstrap })
  });
}

module.exports = {
  FIXTURE_JOB,
  HOST_SCHEMA,
  ShadowHostError,
  bootstrapFixture,
  main,
  validateBootstrapEnvironment
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: HOST_SCHEMA,
      status: "failed",
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_SHADOW_HOST_FAILED"
    })}\n`);
    process.exitCode = 1;
  });
}
