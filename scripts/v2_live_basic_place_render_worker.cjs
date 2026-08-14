"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  APPROVAL_TOKEN: INNER_APPROVAL_TOKEN,
  LIVE_ENV_NAMES: INNER_ENV_NAMES,
  normalizeJob,
  sha256
} = require("./v2_live_basic_place_collector.cjs");

const ROOT = path.resolve(__dirname, "..");
const EXPECTED_NODE_VERSION = "v26.5.0";
const JOB_PATH = path.join(ROOT, "docs", "v2_live_basic_place_render_job.json");
const JOB_RUN_ID = "rebuild-render-basic-place-20260814-001";
const JOB_KEYWORD = "경남 글램핑";
const RENDER_STATE_ROOT = "/var/data/v2-live-basic-place-collector";
const LOCAL_STATE_ROOT = path.join(ROOT, "outputs", "v2-live-basic-place-render");
const LIVE_APPROVAL_TOKEN = "N1-Render-Live";
const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const FILE_IDENTITIES = Object.freeze([
  Object.freeze({ path: "scripts/v2_live_basic_place_collector.cjs", algorithm: "git-blob", expected: "3763256cd4bfe2b2aaaa3bed98679207f7bda688" }),
  Object.freeze({ path: "scripts/naver_place_apollo_parser.cjs", algorithm: "git-blob", expected: "e83364b96706b293a91af3d89cff2efe5fa89e99" }),
  Object.freeze({ path: "scripts/naver_legacy_canary_live_transport.cjs", algorithm: "git-blob", expected: "f346f23e67c358098ef852635fd5351c20cfc891" }),
  Object.freeze({ path: "scripts/gyeongnam_glamping_crawl.cjs", algorithm: "git-blob", expected: "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3" }),
  Object.freeze({ path: "scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs", algorithm: "git-blob", expected: "bcbe229998da3afa6f31ee04375fb0766019e56f" }),
  Object.freeze({ path: "package-lock.json", algorithm: "canonical-sha256", expected: "d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e" })
]);
const OUTER_ENV_NAMES = Object.freeze({
  expectedCommit: "V2_BASIC_RENDER_EXPECTED_DEPLOY_COMMIT",
  stateDir: "V2_BASIC_RENDER_STATE_DIR",
  runEnabled: "V2_BASIC_RENDER_RUN_ENABLED",
  requestBudget: "V2_BASIC_RENDER_REQUEST_BUDGET",
  automaticRetry: "V2_BASIC_RENDER_AUTOMATIC_RETRY",
  fallback: "V2_BASIC_RENDER_FALLBACK",
  operationalWrites: "V2_BASIC_RENDER_OPERATIONAL_WRITES",
  liveApproved: "V2_BASIC_RENDER_LIVE_APPROVED",
  approvedJobDigest: "V2_BASIC_RENDER_APPROVED_JOB_SHA256"
});

class V2BasicRenderError extends Error {
  constructor(code, stage, message, evidence = {}) {
    super(message);
    this.name = "V2BasicRenderError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
    this.evidence = evidence;
  }
}

function fail(code, stage, message, evidence) {
  throw new V2BasicRenderError(code, stage, message, evidence);
}

function canonicalTextBytes(bytes) {
  const source = Buffer.from(bytes).toString("utf8");
  const roundTrip = Buffer.from(source, "utf8");
  if (!roundTrip.equals(Buffer.from(bytes))) fail("V2_BASIC_RENDER_INTEGRITY_MISMATCH", "integrity", "A source file is not UTF-8 text");
  return Buffer.from(source.replace(/\r\n/gu, "\n"), "utf8");
}

function gitBlobSha(bytes) {
  const canonical = canonicalTextBytes(bytes);
  return crypto.createHash("sha1").update(Buffer.from(`blob ${canonical.length}\0`, "utf8")).update(canonical).digest("hex");
}

function fileDigest(identity, bytes) {
  if (identity.algorithm === "git-blob") return gitBlobSha(bytes);
  if (identity.algorithm === "canonical-sha256") return sha256(canonicalTextBytes(bytes));
  fail("V2_BASIC_RENDER_INTEGRITY_MISMATCH", "integrity", "An unsupported file identity was configured");
}

async function readJobIdentity() {
  let bytes;
  let job;
  try {
    bytes = await fs.readFile(JOB_PATH);
    job = normalizeJob(JSON.parse(bytes.toString("utf8")));
  } catch {
    fail("V2_BASIC_RENDER_JOB_INVALID", "job", "The committed Render job is invalid");
  }
  if (job.runId !== JOB_RUN_ID || job.keyword !== JOB_KEYWORD || job.mode !== "live") {
    fail("V2_BASIC_RENDER_JOB_INVALID", "job", "The committed Render job identity changed");
  }
  return Object.freeze({ bytes, job, digest: sha256(bytes) });
}

async function verifyFileIdentities() {
  const identities = {};
  for (const identity of FILE_IDENTITIES) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(ROOT, identity.path));
    } catch {
      fail("V2_BASIC_RENDER_INTEGRITY_MISMATCH", "integrity", "A required source file is missing");
    }
    const actual = fileDigest(identity, bytes);
    if (actual !== identity.expected) fail("V2_BASIC_RENDER_INTEGRITY_MISMATCH", "integrity", "A required source file identity changed");
    identities[identity.path] = actual;
  }
  return Object.freeze(identities);
}

function verifyDeployCommit(env) {
  if (!String(env.RENDER_SERVICE_ID || "").trim()) return null;
  const deployed = String(env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  const expected = String(env[OUTER_ENV_NAMES.expectedCommit] || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(deployed) || deployed !== expected) {
    fail("V2_BASIC_RENDER_DEPLOY_COMMIT_MISMATCH", "integrity", "The Render deploy commit does not match the approved commit");
  }
  return deployed;
}

function resolveStateRoot(env) {
  const configured = String(env[OUTER_ENV_NAMES.stateDir] || "").trim();
  if (!configured || !path.isAbsolute(configured)) fail("V2_BASIC_RENDER_STATE_INVALID", "state", "An absolute state directory is required");
  if (String(env.RENDER_SERVICE_ID || "").trim()) {
    if (configured.replace(/\\/gu, "/") !== RENDER_STATE_ROOT) {
      fail("V2_BASIC_RENDER_STATE_INVALID", "state", "Render must use the dedicated Worker disk");
    }
    return RENDER_STATE_ROOT;
  }
  const localRoot = path.resolve(LOCAL_STATE_ROOT);
  const resolved = path.resolve(configured);
  const relative = path.relative(localRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_BASIC_RENDER_STATE_INVALID", "state", "Local state must be an isolated child directory");
  }
  return resolved;
}

function zeroSafetyGates(env) {
  return [
    OUTER_ENV_NAMES.runEnabled,
    OUTER_ENV_NAMES.requestBudget,
    OUTER_ENV_NAMES.automaticRetry,
    OUTER_ENV_NAMES.fallback,
    OUTER_ENV_NAMES.operationalWrites
  ].every((name) => String(env[name] || "") === "0");
}

function assertReadinessGate(env) {
  if (!zeroSafetyGates(env)) fail("V2_BASIC_RENDER_READINESS_GATE_INVALID", "readiness-gate", "All readiness gates must be zero");
  const forbidden = [
    OUTER_ENV_NAMES.liveApproved,
    OUTER_ENV_NAMES.approvedJobDigest,
    ...Object.values(INNER_ENV_NAMES)
  ];
  if (forbidden.some((name) => String(env[name] || "").trim())) {
    fail("V2_BASIC_RENDER_READINESS_GATE_INVALID", "readiness-gate", "Readiness cannot contain a live approval gate");
  }
}

function assertLiveGate(env, jobDigest) {
  const matched = (
    String(env[OUTER_ENV_NAMES.runEnabled] || "") === "1"
    && String(env[OUTER_ENV_NAMES.requestBudget] || "") === "1"
    && String(env[OUTER_ENV_NAMES.automaticRetry] || "") === "0"
    && String(env[OUTER_ENV_NAMES.fallback] || "") === "0"
    && String(env[OUTER_ENV_NAMES.operationalWrites] || "") === "0"
    && String(env[OUTER_ENV_NAMES.liveApproved] || "") === LIVE_APPROVAL_TOKEN
    && String(env[OUTER_ENV_NAMES.approvedJobDigest] || "") === jobDigest
  );
  if (!matched) fail("V2_BASIC_RENDER_LIVE_GATE_INVALID", "live-gate", "The Render live gate is not an exact match");
  if (Object.values(INNER_ENV_NAMES).some((name) => String(env[name] || "").trim())) {
    fail("V2_BASIC_RENDER_LIVE_GATE_INVALID", "live-gate", "Inner collector gates must not be supplied directly");
  }
}

async function verifyIntegrity(env) {
  if (process.version !== EXPECTED_NODE_VERSION) fail("V2_BASIC_RENDER_INTEGRITY_MISMATCH", "integrity", "Node runtime identity changed");
  const [jobIdentity, files] = await Promise.all([readJobIdentity(), verifyFileIdentities()]);
  return Object.freeze({
    nodeVersion: process.version,
    deployedCommit: verifyDeployCommit(env),
    jobIdentity,
    files
  });
}

async function readiness(env = process.env) {
  assertReadinessGate(env);
  resolveStateRoot(env);
  const integrity = await verifyIntegrity(env);
  return Object.freeze({
    event: "v2_live_basic_place_render_ready",
    status: "ready",
    mode: "readiness-only",
    nodeVersion: integrity.nodeVersion,
    deployedCommit: integrity.deployedCommit,
    runEnabled: false,
    requestBudget: 0,
    liveExecutionAvailable: true,
    externalRequests: 0,
    collectorInvocations: 0,
    operationalWrites: 0,
    retryCount: 0,
    fallbackCount: 0,
    rawProviderResponseStored: false,
    jobDigest: integrity.jobIdentity.digest,
    frozenCollectorBlob: integrity.files["scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs"]
  });
}

function statePaths(root, digest) {
  return Object.freeze({
    claimsRoot: path.join(root, "claims"),
    terminalsRoot: path.join(root, "terminals"),
    artifactsRoot: path.join(root, "artifacts"),
    claim: path.join(root, "claims", `${digest}.json`),
    terminal: path.join(root, "terminals", `${digest}.json`)
  });
}

async function initializeState(paths) {
  await fs.mkdir(paths.claimsRoot, { recursive: true });
  await fs.mkdir(paths.terminalsRoot, { recursive: true });
  await fs.mkdir(paths.artifactsRoot, { recursive: true });
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("V2_BASIC_RENDER_STATE_UNCERTAIN", "state", "Durable state could not be read");
  }
}

async function writeExclusiveJson(filePath, value) {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close?.();
  }
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close?.();
  }
  await fs.rename(temporary, filePath);
}

function isolatedChildEnvironment(jobDigest) {
  const names = ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"];
  const child = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  return Object.freeze({
    ...child,
    NODE_ENV: "production",
    [INNER_ENV_NAMES.approved]: INNER_APPROVAL_TOKEN,
    [INNER_ENV_NAMES.approvedJobDigest]: jobDigest,
    [INNER_ENV_NAMES.requestBudget]: "1",
    [INNER_ENV_NAMES.automaticRetry]: "0",
    [INNER_ENV_NAMES.fallback]: "0",
    [INNER_ENV_NAMES.operationalWrites]: "0"
  });
}

function spawnCollector({ jobDigest, outputRoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, "scripts", "v2_live_basic_place_collector.cjs"),
      "--job", JOB_PATH,
      "--output-root", outputRoot
    ], {
      cwd: ROOT,
      env: isolatedChildEnvironment(jobDigest),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > MAX_CHILD_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", () => reject(new V2BasicRenderError("V2_BASIC_RENDER_CHILD_FAILED", "collector", "The collector child could not start")));
    child.once("close", (exitCode, signal) => {
      if (overflow) return reject(new V2BasicRenderError("V2_BASIC_RENDER_CHILD_OUTPUT_INVALID", "collector", "The collector child output exceeded the safe limit"));
      const lines = stdout.toString("utf8").split(/\r?\n/u).filter((line) => line.trim());
      let result;
      try {
        if (lines.length !== 1) throw new Error("line-count");
        result = JSON.parse(lines[0]);
      } catch {
        return reject(new V2BasicRenderError("V2_BASIC_RENDER_CHILD_OUTPUT_INVALID", "collector", "The collector child output was invalid"));
      }
      resolve(Object.freeze({ exitCode, signal, stderrPresent: stderrBytes > 0, result }));
    });
  });
}

function safeChildProjection(child, jobDigest) {
  const result = child?.result;
  if (!result || typeof result !== "object" || child.stderrPresent) {
    fail("V2_BASIC_RENDER_CHILD_OUTPUT_INVALID", "collector", "The collector child result was unsafe");
  }
  if (child.exitCode === 0) {
    if (
      result.event !== "v2_live_basic_place_complete"
      || result.status !== "completed"
      || result.mode !== "live"
      || result.runId !== JOB_RUN_ID
      || result.keyword !== JOB_KEYWORD
      || !Number.isInteger(result.organicRows)
      || result.organicRows < 1
      || result.organicRows > 50
      || !Number.isInteger(result.advertisementRows)
      || result.advertisementRows < 0
      || result.advertisementRows > 100
      || result.externalRequests !== 1
      || result.retryCount !== 0
      || result.fallbackCount !== 0
      || result.operationalWrites !== 0
      || result.rawProviderResponseStored !== false
      || !/^[a-f0-9]{64}$/u.test(String(result.manifestDigest || ""))
    ) fail("V2_BASIC_RENDER_CHILD_OUTPUT_INVALID", "collector", "The collector success result escaped its contract");
    return Object.freeze({
      status: "completed",
      organicRows: result.organicRows,
      advertisementRows: result.advertisementRows,
      manifestDigest: result.manifestDigest,
      errorCode: null,
      externalRequests: 1
    });
  }
  if (
    result.event !== "v2_live_basic_place_failed"
    || result.status !== "failed"
    || typeof result.code !== "string"
    || result.code.length > 120
    || !Number.isInteger(result.externalRequests)
    || ![0, 1].includes(result.externalRequests)
    || result.operationalWrites !== 0
  ) fail("V2_BASIC_RENDER_CHILD_OUTPUT_INVALID", "collector", "The collector failure result escaped its contract");
  return Object.freeze({
    status: "failed",
    organicRows: 0,
    advertisementRows: 0,
    manifestDigest: null,
    errorCode: result.code,
    externalRequests: result.externalRequests,
    jobDigest
  });
}

async function executeLive(env = process.env, options = {}) {
  const integrity = await verifyIntegrity(env);
  const root = resolveStateRoot(env);
  assertLiveGate(env, integrity.jobIdentity.digest);
  const paths = statePaths(root, integrity.jobIdentity.digest);
  await initializeState(paths);
  const existingTerminal = await readJsonIfPresent(paths.terminal);
  if (existingTerminal) {
    return Object.freeze({
      event: "v2_live_basic_place_render_duplicate",
      status: "duplicate",
      runId: JOB_RUN_ID,
      jobDigest: integrity.jobIdentity.digest,
      terminalDigest: sha256(Buffer.from(JSON.stringify(existingTerminal), "utf8")),
      externalRequests: 0,
      collectorInvocations: 0,
      operationalWrites: 0
    });
  }
  const existingClaim = await readJsonIfPresent(paths.claim);
  if (existingClaim) fail("V2_BASIC_RENDER_RESULT_UNCERTAIN", "claim", "A claim exists without a terminal result");
  const claim = Object.freeze({
    schemaVersion: "v2-live-basic-place-render-claim.v1",
    runId: JOB_RUN_ID,
    jobDigest: integrity.jobIdentity.digest,
    deployedCommit: integrity.deployedCommit,
    claimedAt: new Date().toISOString(),
    requestBudget: 1,
    retryCount: 0,
    fallbackCount: 0,
    operationalWrites: 0
  });
  try {
    await writeExclusiveJson(paths.claim, claim);
  } catch (error) {
    if (error instanceof V2BasicRenderError) throw error;
    fail("V2_BASIC_RENDER_RESULT_UNCERTAIN", "claim", "The durable claim could not be committed");
  }
  const childRunner = options.childRunner || spawnCollector;
  let child;
  try {
    child = await childRunner({
      jobDigest: integrity.jobIdentity.digest,
      outputRoot: paths.artifactsRoot,
      childEnv: isolatedChildEnvironment(integrity.jobIdentity.digest)
    });
  } catch {
    fail("V2_BASIC_RENDER_RESULT_UNCERTAIN", "collector", "The claimed collector result is uncertain");
  }
  const projection = safeChildProjection(child, integrity.jobIdentity.digest);
  const terminal = Object.freeze({
    schemaVersion: "v2-live-basic-place-render-terminal.v1",
    event: "v2_live_basic_place_render_terminal",
    runId: JOB_RUN_ID,
    jobDigest: integrity.jobIdentity.digest,
    status: projection.status,
    organicRows: projection.organicRows,
    advertisementRows: projection.advertisementRows,
    manifestDigest: projection.manifestDigest,
    errorCode: projection.errorCode,
    externalRequests: projection.externalRequests,
    collectorInvocations: 1,
    retryCount: 0,
    fallbackCount: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    completedAt: new Date().toISOString()
  });
  try {
    await writeAtomicJson(paths.terminal, terminal);
  } catch {
    fail("V2_BASIC_RENDER_RESULT_UNCERTAIN", "terminal", "The terminal result could not be committed");
  }
  return terminal;
}

function holdUntilSignal() {
  return new Promise((resolve) => {
    const keepalive = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
    const finish = (signal) => {
      clearInterval(keepalive);
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInterrupt);
      resolve(signal);
    };
    const onTerm = () => finish("SIGTERM");
    const onInterrupt = () => finish("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInterrupt);
  });
}

function safeError(error) {
  return Object.freeze({
    event: "v2_live_basic_place_render_failed",
    status: "failed",
    code: String(error?.code || "V2_BASIC_RENDER_FAILED").slice(0, 120),
    stage: String(error?.stage || "unexpected").slice(0, 80),
    retryable: false,
    externalRequests: Number(error?.evidence?.externalRequests || 0),
    collectorInvocations: Number(error?.evidence?.collectorInvocations || 0),
    operationalWrites: 0
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["readiness", "serve", "live-and-hold"].includes(argv[0])) {
    fail("V2_BASIC_RENDER_COMMAND_INVALID", "command", "usage: readiness|serve|live-and-hold");
  }
  const result = argv[0] === "live-and-hold" ? await executeLive(process.env) : await readiness(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (["serve", "live-and-hold"].includes(argv[0])) await holdUntilSignal();
}

if (require.main === module) {
  main().catch(async (error) => {
    process.stdout.write(`${JSON.stringify(safeError(error))}\n`);
    if (process.argv.includes("live-and-hold")) await holdUntilSignal();
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_NODE_VERSION,
  FILE_IDENTITIES,
  JOB_PATH,
  JOB_RUN_ID,
  LIVE_APPROVAL_TOKEN,
  LOCAL_STATE_ROOT,
  OUTER_ENV_NAMES,
  RENDER_STATE_ROOT,
  V2BasicRenderError,
  assertLiveGate,
  assertReadinessGate,
  executeLive,
  gitBlobSha,
  isolatedChildEnvironment,
  readJobIdentity,
  readiness,
  resolveStateRoot,
  safeChildProjection,
  safeError,
  sha256,
  verifyFileIdentities,
  verifyIntegrity
};
