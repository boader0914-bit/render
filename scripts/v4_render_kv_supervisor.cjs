const {
  initializeFixtureTransport
} = require("./v4_fixture_transport_fs.cjs");
const {
  RenderKeyValueTransport,
  configFromEnvironment
} = require("./v4_render_kv_transport.cjs");
const {
  main: runSupervisor,
  validateSupervisorEnvironment
} = require("./v4_fixture_transport_supervisor.cjs");

const ENTRYPOINT_SCHEMA = "datalab-v4-render-kv-supervisor.v1";

async function createRuntime(env = process.env, options = {}) {
  const config = validateSupervisorEnvironment(env);
  if (config.transportMode !== "render-key-value") {
    throw Object.assign(new Error("Render Key Value transport mode is required."), {
      code: "V4_QUEUE_MODE_REQUIRED",
      stage: "environment"
    });
  }
  const roots = await initializeFixtureTransport(config.transportRoot);
  const createTransport = () => options.transport || new RenderKeyValueTransport({
    ...configFromEnvironment(env, config.keyring),
    bullmq: options.bullmq,
    bullmqVersion: options.bullmqVersion
  });
  return { config, roots, createTransport };
}

async function main(options = {}) {
  const runtime = options.runtime || await createRuntime(options.env || process.env, options);
  return runSupervisor(runtime);
}

module.exports = {
  ENTRYPOINT_SCHEMA,
  createRuntime,
  main
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: ENTRYPOINT_SCHEMA,
      status: "failed",
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "V4_QUEUE_SUPERVISOR_FATAL"
    })}\n`);
    process.exitCode = 1;
  });
}
