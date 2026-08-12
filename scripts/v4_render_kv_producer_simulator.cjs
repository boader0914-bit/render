const {
  PRODUCER_SCHEMA,
  parseArgs,
  produceFixtureJob,
  readJobFile,
  validateProducerEnvironment
} = require("./v4_fixture_producer_simulator.cjs");
const {
  RenderKeyValueTransport,
  configFromEnvironment
} = require("./v4_render_kv_transport.cjs");

async function createProducerRuntime(env = process.env, options = {}) {
  const config = validateProducerEnvironment(env);
  if (config.transportMode !== "render-key-value") {
    throw Object.assign(new Error("Render Key Value transport mode is required."), {
      code: "V4_QUEUE_MODE_REQUIRED",
      stage: "environment"
    });
  }
  const transport = options.transport || new RenderKeyValueTransport({
    ...configFromEnvironment(env, config.keyring),
    claimsEnabled: false,
    bullmq: options.bullmq,
    bullmqVersion: options.bullmqVersion
  });
  return { config, transport };
}

async function run(argv = process.argv.slice(2), env = process.env, options = {}) {
  const runtime = options.runtime || await createProducerRuntime(env, options);
  try {
    await runtime.transport.ready();
    const args = parseArgs(argv);
    const job = await readJobFile(args.jobFile);
    return await produceFixtureJob({
      ...runtime.config,
      transport: runtime.transport,
      job,
      scenario: args.scenario,
      ttlMs: args.ttlMs
    });
  } finally {
    await runtime.transport.close().catch(() => {});
  }
}

async function main() {
  let output;
  try {
    output = await run();
  } catch (error) {
    output = {
      schemaVersion: PRODUCER_SCHEMA,
      status: "failed",
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "V4_QUEUE_PRODUCER_FAILED",
      stage: /^[a-zA-Z0-9._:-]{1,120}$/.test(String(error?.stage || "")) ? error.stage : "producer",
      retryable: error?.retryable === true,
      collectorInvocations: 0
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  createProducerRuntime,
  main,
  run
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: PRODUCER_SCHEMA,
      status: "failed",
      code: "V4_QUEUE_PRODUCER_FAILED",
      collectorInvocations: 0
    })}\n`);
    process.exitCode = 1;
  });
}
