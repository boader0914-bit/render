const {
  bootstrapFixture,
  validateBootstrapEnvironment
} = require("./v4_fixture_transport_shadow_host.cjs");
const {
  createRuntime
} = require("./v4_render_kv_supervisor.cjs");
const {
  main: runSupervisor
} = require("./v4_fixture_transport_supervisor.cjs");

const HOST_SCHEMA = "datalab-v4-render-kv-shadow-host.v1";

async function main(options = {}) {
  const env = options.env || process.env;
  const runtime = options.runtime || await createRuntime(env, options);
  const bootstrap = validateBootstrapEnvironment(env);
  return runSupervisor({
    ...runtime,
    beforeReady: ({ transport }) => bootstrapFixture({ ...runtime, transport, bootstrap })
  });
}

module.exports = { HOST_SCHEMA, main };

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: HOST_SCHEMA,
      status: "failed",
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "V4_QUEUE_SHADOW_HOST_FAILED"
    })}\n`);
    process.exitCode = 1;
  });
}
