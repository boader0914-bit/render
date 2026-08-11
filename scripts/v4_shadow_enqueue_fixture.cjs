const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  ensureDedicatedDataRoot,
  normalizeJob,
  verifyOriginalCollector
} = require("./v4_worker_once.cjs");
const {
  TransportError,
  enqueueFixture,
  initializeTransport,
  normalizeEnvelope
} = require("./v4_shadow_transport.cjs");

const MAX_INPUT_BYTES = 64 * 1024;

function safeMessage(value) {
  let text = String(value || "Transport failed.");
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)) continue;
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseArgs(argv) {
  let jobFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-file") jobFile = argv[++index] || "";
    else if (token.startsWith("--job-file=")) jobFile = token.slice("--job-file=".length);
    else throw new TransportError("TRANSPORT_ARGUMENT_INVALID", `Unknown argument: ${token}`);
  }
  return { jobFile };
}

async function readInput(jobFile) {
  if (jobFile) {
    const filePath = path.resolve(jobFile);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new TransportError("TRANSPORT_INPUT_NOT_FOUND", "Input file does not exist.");
    if (stat.size > MAX_INPUT_BYTES) throw new TransportError("TRANSPORT_INPUT_TOO_LARGE", "Input exceeds 64 KiB.");
    return fsp.readFile(filePath, "utf8");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new TransportError("TRANSPORT_INPUT_TOO_LARGE", "Input exceeds 64 KiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new TransportError("SHADOW_NETWORK_BLOCKER_REQUIRED", "Fixture enqueue must start with the offline network blocker.");
  }
  const { jobFile } = parseArgs(process.argv.slice(2));
  const text = await readInput(jobFile);
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new TransportError("TRANSPORT_INPUT_INVALID_JSON", "Input is not valid JSON.");
  }
  const envelope = normalizeEnvelope(input);
  envelope.job = normalizeJob(envelope.job);
  await verifyOriginalCollector();
  const workerRoots = await ensureDedicatedDataRoot(process.env.V4_WORKER_DATA_DIR);
  const roots = await initializeTransport(workerRoots);
  const stored = await enqueueFixture(roots, envelope);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: stored.schemaVersion,
    status: "enqueued",
    code: "OK",
    transportId: stored.transportId,
    jobId: stored.job.jobId,
    fixtureScenario: stored.fixtureScenario
  })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: "failed",
    code: error?.code || "TRANSPORT_INTERNAL_ERROR",
    message: safeMessage(error?.message),
    retryable: false
  })}\n`);
  process.exitCode = 1;
});
