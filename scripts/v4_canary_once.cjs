const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  BASELINE_COMMIT,
  EXPECTED_COLLECTOR_BLOB,
  verifyOriginalCollector
} = require("./v4_worker_once.cjs");
const {
  CANARY_HOSTNAME,
  CANARY_PROVIDER,
  CanaryNetworkError,
  createCanaryTransport
} = require("./v4_canary_transport.cjs");

const ROOT = path.resolve(__dirname, "..");
const CANARY_JOB_SCHEMA = "datalab-v4-canary-job.v1";
const CANARY_RESULT_SCHEMA = "datalab-v4-canary-result.v1";
const CANARY_ARTIFACT_SCHEMA = "datalab-v4-canary-artifact.v1";
const CANARY_ROOT_SCHEMA = "datalab-v4-canary-root.v1";
const MAX_INPUT_BYTES = 32 * 1024;
const JOB_FIELDS = new Set([
  "schemaVersion",
  "approvalId",
  "jobId",
  "idempotencyKey",
  "provider",
  "keyword"
]);
const OPERATIONAL_ENV_NAMES = [
  "DATABASE_URL",
  "DB_URL",
  "POSTGRES_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "REDIS_URL",
  "KV_URL",
  "WEB_IMPORT_URL",
  "V4_WEB_IMPORT_URL"
];

class CanaryError extends Error {
  constructor(code, stage, message, details = null) {
    super(message);
    this.name = "CanaryError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(parent, child) {
  if (!isContained(parent, child)) {
    throw new CanaryError("CANARY_PATH_OUTSIDE_ROOT", "storage", "Canary path is outside its dedicated root.");
  }
}

function safeIdentifier(value, field) {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(text)) {
    throw new CanaryError("CANARY_JOB_IDENTIFIER_INVALID", "validate", `${field} is invalid.`);
  }
  return text;
}

function normalizeCanaryJob(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new CanaryError("CANARY_JOB_NOT_OBJECT", "validate", "Canary job must be a JSON object.");
  }
  const unknown = Object.keys(spec).filter((key) => !JOB_FIELDS.has(key));
  if (unknown.length) {
    throw new CanaryError("CANARY_JOB_UNKNOWN_FIELD", "validate", `Unknown canary job field: ${unknown.sort()[0]}`);
  }
  if (spec.schemaVersion !== CANARY_JOB_SCHEMA) {
    throw new CanaryError("CANARY_JOB_SCHEMA_INVALID", "validate", `schemaVersion must be ${CANARY_JOB_SCHEMA}.`);
  }
  const keyword = String(spec.keyword || "").normalize("NFKC").trim();
  if (!keyword || keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    throw new CanaryError("CANARY_JOB_KEYWORD_INVALID", "validate", "keyword is empty, too long, or contains control characters.");
  }
  const provider = String(spec.provider || "").trim();
  if (provider !== CANARY_PROVIDER) {
    throw new CanaryError("CANARY_PROVIDER_NOT_APPROVED", "validate", "Only the approved canary provider is allowed.");
  }
  return {
    schemaVersion: CANARY_JOB_SCHEMA,
    approvalId: safeIdentifier(spec.approvalId, "approvalId"),
    jobId: safeIdentifier(spec.jobId, "jobId"),
    idempotencyKey: safeIdentifier(spec.idempotencyKey, "idempotencyKey"),
    provider,
    keyword
  };
}

function sensitiveValues(env) {
  return Object.entries(env || {})
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|CLIENT_ID)/i.test(name) && String(value || "").length >= 4)
    .map(([, value]) => String(value))
    .sort((a, b) => b.length - a.length);
}

function sanitizeText(value, env = process.env) {
  let text = String(value || "");
  for (const secret of sensitiveValues(env)) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/(authorization|api[_-]?key|client[_-]?(?:id|secret)|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function validateCanaryGates(job, env, options = {}) {
  for (const name of ["V4_CANARY_OPERATIONAL_PUBLISH_ENABLED", "V4_CANARY_WEB_IMPORT_ENABLED"]) {
    if (env[name] !== "0") {
      throw new CanaryError("CANARY_OPERATIONAL_GATE_INVALID", "environment", `${name} must be exactly 0.`);
    }
  }
  const forbidden = OPERATIONAL_ENV_NAMES.filter((name) => String(env[name] || "").trim());
  if (forbidden.length) {
    throw new CanaryError(
      "CANARY_OPERATIONAL_ENV_FORBIDDEN",
      "environment",
      `Operational connection variables are forbidden: ${forbidden.sort().join(", ")}.`
    );
  }
  if (!env.V4_CANARY_APPROVAL_ID || env.V4_CANARY_APPROVAL_ID !== job.approvalId) {
    throw new CanaryError("CANARY_APPROVAL_MISMATCH", "approval", "Job approvalId does not match the isolated runtime approval.");
  }
  if (env.V4_CANARY_MODE === "offline-test") {
    if (!options.allowOfflineFixture || globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
      throw new CanaryError("CANARY_OFFLINE_BLOCKER_REQUIRED", "environment", "Offline canary requires the network blocker.");
    }
    if (env.V4_CANARY_EXTERNAL_CALLS_ENABLED !== "0" || env.V4_CANARY_NETWORK_GATE_ENABLED !== "0") {
      throw new CanaryError("CANARY_OFFLINE_GATE_INVALID", "environment", "Offline canary network gates must be exactly 0.");
    }
    return;
  }
  if (env.V4_CANARY_MODE !== "live-approved" || !options.allowLiveExecution) {
    throw new CanaryError("CANARY_LIVE_APPROVAL_REQUIRED", "approval", "Live canary execution requires the explicit approved-live entrypoint.");
  }
  if (env.V4_CANARY_EXTERNAL_CALLS_ENABLED !== "1" || env.V4_CANARY_NETWORK_GATE_ENABLED !== "1") {
    throw new CanaryError("CANARY_LIVE_GATE_INVALID", "environment", "Live canary network gates must be exactly 1.");
  }
  for (const name of ["V4_CANARY_NAVER_CLIENT_ID", "V4_CANARY_NAVER_CLIENT_SECRET"]) {
    if (!String(env[name] || "").trim()) {
      throw new CanaryError("CANARY_CREDENTIAL_REQUIRED", "environment", `${name} is required for the approved provider.`);
    }
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fsp.link(temporary, filePath);
    await fsp.unlink(temporary);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureCanaryDataRoot(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new CanaryError("CANARY_DATA_ROOT_REQUIRED", "storage", "V4_CANARY_DATA_DIR must be an absolute dedicated path.");
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root || isContained(ROOT, root) || isContained(root, ROOT)) {
    throw new CanaryError("CANARY_DATA_ROOT_UNSAFE", "storage", "Canary data root cannot overlap the repository.");
  }
  let existed = true;
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CanaryError("CANARY_DATA_ROOT_UNSAFE", "storage", "Canary data root must be a real directory.");
    }
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    if (error.code !== "ENOENT") throw error;
    existed = false;
    await fsp.mkdir(root, { recursive: true });
  }
  const marker = path.join(root, ".v4-canary-root.json");
  if (!fs.existsSync(marker)) {
    const entries = await fsp.readdir(root);
    if (existed && entries.length) {
      throw new CanaryError("CANARY_DATA_ROOT_NOT_DEDICATED", "storage", "Existing canary root is not dedicated.");
    }
    await writeJsonAtomic(marker, {
      schemaVersion: CANARY_ROOT_SCHEMA,
      baselineCommit: BASELINE_COMMIT,
      collectorBlob: EXPECTED_COLLECTOR_BLOB
    });
  } else {
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(marker, "utf8"));
    } catch {
      throw new CanaryError("CANARY_DATA_ROOT_MARKER_INVALID", "storage", "Canary root marker is invalid.");
    }
    if (
      parsed.schemaVersion !== CANARY_ROOT_SCHEMA
      || parsed.baselineCommit !== BASELINE_COMMIT
      || parsed.collectorBlob !== EXPECTED_COLLECTOR_BLOB
    ) {
      throw new CanaryError("CANARY_DATA_ROOT_MARKER_INVALID", "storage", "Canary root marker does not match the frozen baseline.");
    }
  }
  const roots = {
    root,
    work: path.join(root, "work"),
    artifacts: path.join(root, "artifacts"),
    idempotency: path.join(root, "idempotency"),
    locks: path.join(root, "locks")
  };
  for (const directory of Object.values(roots).slice(1)) {
    assertContained(root, directory);
    await fsp.mkdir(directory, { recursive: true });
  }
  return roots;
}

function jobFingerprint(job) {
  return sha256(stableJson({
    schemaVersion: job.schemaVersion,
    approvalId: job.approvalId,
    jobId: job.jobId,
    provider: job.provider,
    keyword: job.keyword
  }));
}

function providerRequest(job, env) {
  const target = new URL(`https://${CANARY_HOSTNAME}/v1/search/local.json`);
  target.searchParams.set("query", job.keyword);
  target.searchParams.set("display", "1");
  target.searchParams.set("start", "1");
  target.searchParams.set("sort", "random");
  return {
    url: target,
    headers: {
      "x-naver-client-id": env.V4_CANARY_NAVER_CLIENT_ID || "offline-client-id",
      "x-naver-client-secret": env.V4_CANARY_NAVER_CLIENT_SECRET || "offline-client-secret"
    }
  };
}

function summarizeNaverResponse(response) {
  const data = response?.data;
  if (
    !data
    || typeof data !== "object"
    || !Number.isInteger(data.total)
    || !Number.isInteger(data.start)
    || !Number.isInteger(data.display)
    || !Array.isArray(data.items)
    || data.items.length > 1
  ) {
    throw new CanaryError("CANARY_PROVIDER_SCHEMA_INVALID", "validate_response", "Provider response did not match the approved minimal schema.");
  }
  return {
    httpStatus: response.statusCode,
    total: data.total,
    start: data.start,
    display: data.display,
    returnedItems: data.items.length,
    responseBytes: response.responseBytes,
    responseDigest: response.responseDigest
  };
}

async function readRecord(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CanaryError("CANARY_IDEMPOTENCY_RECORD_INVALID", "idempotency", "Canary idempotency record is invalid.");
  }
}

function duplicateResult(record, job) {
  if (record.jobFingerprint !== jobFingerprint(job)) {
    throw new CanaryError("CANARY_IDEMPOTENCY_CONFLICT", "idempotency", "Idempotency key is bound to another canary job.");
  }
  if (record.status === "failed") {
    throw new CanaryError("CANARY_IDEMPOTENCY_PREVIOUS_FAILURE", "idempotency", "Previous canary attempt failed; automatic retry is forbidden.");
  }
  if (record.status !== "succeeded") {
    throw new CanaryError("CANARY_IDEMPOTENCY_RECORD_INVALID", "idempotency", "Canary idempotency status is invalid.");
  }
  return {
    schemaVersion: CANARY_RESULT_SCHEMA,
    status: "duplicate",
    code: "CANARY_IDEMPOTENT_REPLAY",
    jobId: job.jobId,
    provider: job.provider,
    artifactId: record.artifactId,
    requestCount: 0,
    operationalWrites: false,
    retryable: false,
    duplicate: true
  };
}

async function executeCanary(spec, options = {}) {
  const env = options.env || process.env;
  const collectorBlob = await verifyOriginalCollector();
  const job = normalizeCanaryJob(spec);
  validateCanaryGates(job, env, options);
  const roots = await ensureCanaryDataRoot(options.dataRoot || env.V4_CANARY_DATA_DIR);
  const idempotencyKeyHash = sha256(job.idempotencyKey);
  const recordFile = path.join(roots.idempotency, `${idempotencyKeyHash}.json`);
  const existing = await readRecord(recordFile);
  if (existing) return duplicateResult(existing, job);

  const globalLock = path.join(roots.locks, "canary-execution.lock");
  let lockHandle = null;
  let stageRoot = null;
  const fingerprint = jobFingerprint(job);
  const artifactId = `${job.jobId.replaceAll(":", "_")}-${idempotencyKeyHash.slice(0, 12)}`;
  const artifactDir = path.join(roots.artifacts, artifactId);
  assertContained(roots.artifacts, artifactDir);

  try {
    try {
      lockHandle = await fsp.open(globalLock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new CanaryError("CANARY_CONCURRENCY_LOCKED", "concurrency", "Another canary execution owns the dedicated root.");
      }
      throw error;
    }
    await lockHandle.writeFile(`${JSON.stringify({ schemaVersion: CANARY_RESULT_SCHEMA, jobId: job.jobId })}\n`, "utf8");
    const raced = await readRecord(recordFile);
    if (raced) return duplicateResult(raced, job);
    if (fs.existsSync(artifactDir)) {
      throw new CanaryError("CANARY_ARTIFACT_CONFLICT", "promote", "Canary artifact target already exists.");
    }

    stageRoot = await fsp.mkdtemp(path.join(roots.work, `${idempotencyKeyHash.slice(0, 12)}-`));
    assertContained(roots.work, stageRoot);
    const stagedArtifact = path.join(stageRoot, "artifact");
    await fsp.mkdir(stagedArtifact);

    const transport = options.transport || createCanaryTransport({ env });
    const response = await transport.requestJson(providerRequest(job, env));
    if (transport.requestCount !== 1 || response.requestCount !== 1) {
      throw new CanaryError("CANARY_REQUEST_COUNT_INVALID", "network", "Canary must perform exactly one provider request.");
    }
    const providerSummary = summarizeNaverResponse(response);
    const artifact = {
      schemaVersion: CANARY_ARTIFACT_SCHEMA,
      baselineCommit: BASELINE_COMMIT,
      collectorBlob,
      collectorInvoked: false,
      approvalIdHash: sha256(job.approvalId),
      jobId: job.jobId,
      idempotencyKeyHash,
      jobFingerprint: fingerprint,
      provider: job.provider,
      hostname: CANARY_HOSTNAME,
      keywordHash: sha256(job.keyword),
      providerRequestCount: 1,
      automaticRetry: false,
      automaticFallback: false,
      operationalPublish: false,
      webImport: false,
      databaseWrite: false,
      rawProviderResponseStored: false,
      providerSummary,
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(path.join(stagedArtifact, "manifest.json"), artifact);
    if (options.testFault === "after-stage-write") {
      throw new CanaryError("CANARY_TEST_STAGE_FAILURE", "test", "Injected failure after staged artifact write.");
    }
    await fsp.rename(stagedArtifact, artifactDir);

    const record = {
      schemaVersion: CANARY_RESULT_SCHEMA,
      status: "succeeded",
      jobId: job.jobId,
      idempotencyKeyHash,
      jobFingerprint: fingerprint,
      artifactId,
      requestCount: 1,
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(recordFile, record);
    return {
      schemaVersion: CANARY_RESULT_SCHEMA,
      status: "succeeded",
      code: "OK",
      jobId: job.jobId,
      provider: job.provider,
      artifactId,
      requestCount: 1,
      operationalWrites: false,
      retryable: false,
      duplicate: false
    };
  } catch (error) {
    const canaryError = error instanceof CanaryError || error instanceof CanaryNetworkError
      ? error
      : new CanaryError("CANARY_INTERNAL_ERROR", "canary", sanitizeText(error?.message || error, env));
    if (lockHandle && !fs.existsSync(recordFile)) {
      await writeJsonAtomic(recordFile, {
        schemaVersion: CANARY_RESULT_SCHEMA,
        status: "failed",
        jobId: job.jobId,
        idempotencyKeyHash,
        jobFingerprint: fingerprint,
        code: canaryError.code,
        stage: canaryError.stage,
        retryable: false,
        createdAt: new Date().toISOString()
      }).catch(() => {});
    }
    throw canaryError;
  } finally {
    if (stageRoot) await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (lockHandle) await fsp.unlink(globalLock).catch(() => {});
  }
}

function publicFailure(error, rawJobId, env = process.env) {
  const normalized = error instanceof CanaryError || error instanceof CanaryNetworkError
    ? error
    : new CanaryError("CANARY_INTERNAL_ERROR", "canary", error?.message || String(error));
  const jobId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(String(rawJobId || "")) ? String(rawJobId) : "";
  const result = {
    schemaVersion: CANARY_RESULT_SCHEMA,
    status: "failed",
    code: normalized.code,
    stage: normalized.stage || "canary",
    jobId,
    message: sanitizeText(normalized.message, env),
    retryable: false
  };
  if (normalized.details && typeof normalized.details === "object") result.details = normalized.details;
  return result;
}

function parseArgs(argv) {
  let jobFile = "";
  let jobEnv = false;
  let offlineFixture = "";
  let approvedLive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-file") jobFile = argv[++index] || "";
    else if (token.startsWith("--job-file=")) jobFile = token.slice("--job-file=".length);
    else if (token === "--job-env") jobEnv = true;
    else if (token === "--offline-fixture") offlineFixture = argv[++index] || "success";
    else if (token.startsWith("--offline-fixture=")) offlineFixture = token.slice("--offline-fixture=".length) || "success";
    else if (token === "--approved-live") approvedLive = true;
    else throw new CanaryError("CANARY_ARGUMENT_INVALID", "input", `Unknown argument: ${token}`);
  }
  if (offlineFixture && offlineFixture !== "success") {
    throw new CanaryError("CANARY_FIXTURE_INVALID", "input", "Only the success offline fixture is available.");
  }
  if (offlineFixture && approvedLive) {
    throw new CanaryError("CANARY_ARGUMENT_INVALID", "input", "Offline fixture and approved live modes are mutually exclusive.");
  }
  if (jobFile && jobEnv) {
    throw new CanaryError("CANARY_ARGUMENT_INVALID", "input", "--job-file and --job-env are mutually exclusive.");
  }
  return { jobFile, jobEnv, offlineFixture, approvedLive };
}

async function readInput(jobFile, jobEnv, env = process.env) {
  let bytes;
  if (jobEnv) {
    bytes = Buffer.from(String(env.V4_CANARY_JOB_JSON || ""), "utf8");
    if (bytes.length > MAX_INPUT_BYTES) throw new CanaryError("CANARY_JOB_INPUT_TOO_LARGE", "input", "Canary job exceeds 32 KiB.");
  } else if (jobFile) {
    const filePath = path.resolve(jobFile);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new CanaryError("CANARY_JOB_FILE_NOT_FOUND", "input", "Canary job file does not exist.");
    if (stat.size > MAX_INPUT_BYTES) throw new CanaryError("CANARY_JOB_INPUT_TOO_LARGE", "input", "Canary job exceeds 32 KiB.");
    bytes = await fsp.readFile(filePath);
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) throw new CanaryError("CANARY_JOB_INPUT_TOO_LARGE", "input", "Canary job exceeds 32 KiB.");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (!bytes.length) throw new CanaryError("CANARY_JOB_INPUT_EMPTY", "input", "Canary job input is empty.");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryError("CANARY_JOB_INPUT_INVALID_JSON", "input", "Canary job input is not valid JSON.");
  }
}

async function main() {
  let rawJob = null;
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    rawJob = await readInput(args.jobFile, args.jobEnv);
    const options = {
      allowOfflineFixture: Boolean(args.offlineFixture),
      allowLiveExecution: args.approvedLive
    };
    if (args.offlineFixture) {
      const { createOfflineCanaryTransport } = require("./fixtures/v4_canary_fixture_transport.cjs");
      options.transport = createOfflineCanaryTransport(process.env);
    }
    result = await executeCanary(rawJob, options);
  } catch (error) {
    result = publicFailure(error, rawJob?.jobId);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  CANARY_ARTIFACT_SCHEMA,
  CANARY_JOB_SCHEMA,
  CANARY_RESULT_SCHEMA,
  CanaryError,
  OPERATIONAL_ENV_NAMES,
  ensureCanaryDataRoot,
  executeCanary,
  normalizeCanaryJob,
  publicFailure,
  sanitizeText,
  validateCanaryGates
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(publicFailure(error, ""))}\n`);
    process.exitCode = 1;
  });
}
