"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  jobApprovalDigest,
  normalizeJob
} = require("./v2_naver_place_room_provider_marker_live_one_shot.cjs");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_COMMIT = "a977872f8f3de20775a3e2dab92f9161cb69515e";
const EXPECTED_NODE_VERSION = "v26.5.0";
const JOB_RUN_ID = "n5-room-marker-render-live-20260814-001";
const JOB_CANONICAL_SHA256 = "bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7";
const JOB_PATH = path.join(ROOT, "docs", "v2_naver_place_room_provider_marker_render_live_job.proposal.json");
const RENDER_STATE_ROOT = "/var/data/v2-room-provider-marker-diagnostic";
const LOCAL_STATE_ROOT = path.join(ROOT, "outputs", "rebuild-n5-d4");
const PROCESS_KEEPALIVE_INTERVAL_MS = 60_000;
const READINESS_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-readiness.v1";
const ERROR_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-readiness-error.v1";
const READINESS_EVENT = "n5_room_provider_marker_render_ready";
const FILE_IDENTITIES = Object.freeze([
  Object.freeze({
    key: "runnerBlob",
    path: "scripts/v2_naver_place_room_provider_marker_live_one_shot.cjs",
    algorithm: "git-blob",
    expected: "70eb4024b8c623569d13666a0757738c447df214"
  }),
  Object.freeze({
    key: "contractBlob",
    path: "scripts/v2_naver_place_room_provider_marker_contract.cjs",
    algorithm: "git-blob",
    expected: "0098a89d940fb4436ac7fa9810e7e6582870d7c2"
  }),
  Object.freeze({
    key: "currentCollectorBlob",
    path: "scripts/gyeongnam_glamping_crawl.cjs",
    algorithm: "git-blob",
    expected: "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3"
  }),
  Object.freeze({
    key: "frozenCollectorBlob",
    path: "scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs",
    algorithm: "git-blob",
    expected: "bcbe229998da3afa6f31ee04375fb0766019e56f"
  }),
  Object.freeze({
    key: "packageLockSha256",
    path: "package-lock.json",
    algorithm: "sha256",
    expected: "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2"
  })
]);
const SAFE_ERROR_CODES = new Set([
  "V2_N5_RENDER_COMMAND_INVALID",
  "V2_N5_RENDER_DEPLOY_COMMIT_MISMATCH",
  "V2_N5_RENDER_FAILED",
  "V2_N5_RENDER_INTEGRITY_MISMATCH",
  "V2_N5_RENDER_JOB_INVALID",
  "V2_N5_RENDER_READINESS_GATE_INVALID",
  "V2_N5_RENDER_STATE_INVALID"
]);

class V2N5RenderReadinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2N5RenderReadinessError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2N5RenderReadinessError(code, message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalGitTextBytes(bytes) {
  const source = Buffer.from(bytes).toString("utf8");
  const roundTrip = Buffer.from(source, "utf8");
  if (!roundTrip.equals(Buffer.from(bytes))) {
    fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "A required source file is not canonical UTF-8 text");
  }
  return Buffer.from(source.replace(/\r\n/gu, "\n"), "utf8");
}

function gitBlobSha(bytes) {
  const canonical = canonicalGitTextBytes(bytes);
  const header = Buffer.from(`blob ${canonical.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(canonical).digest("hex");
}

async function readFreshJob(jobPath = JOB_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(jobPath), "utf8"));
  } catch {
    fail("V2_N5_RENDER_JOB_INVALID", "Fresh Render diagnostic job JSON is invalid");
  }
  let job;
  try {
    job = normalizeJob(parsed);
  } catch {
    fail("V2_N5_RENDER_JOB_INVALID", "Fresh Render diagnostic job contract is invalid");
  }
  const digest = jobApprovalDigest(job);
  if (
    job.runId !== JOB_RUN_ID
    || job.mode !== "live"
    || job.placeId !== "35644668"
    || job.requestBudget !== 1
    || job.automaticRetries !== 0
    || job.automaticFallbacks !== 0
    || digest !== JOB_CANONICAL_SHA256
  ) fail("V2_N5_RENDER_JOB_INVALID", "Fresh Render diagnostic job identity changed");
  return Object.freeze({ job, digest });
}

function verifyRenderDeployIdentity(env = process.env) {
  if (!String(env.RENDER_SERVICE_ID || "").trim()) {
    return Object.freeze({ render: false, deployedCommit: null });
  }
  const deployedCommit = String(env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  const expectedCommit = String(env.V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT || "").trim().toLowerCase();
  if (
    !/^[a-f0-9]{40}$/u.test(deployedCommit)
    || !/^[a-f0-9]{40}$/u.test(expectedCommit)
    || deployedCommit !== expectedCommit
  ) fail("V2_N5_RENDER_DEPLOY_COMMIT_MISMATCH", "Render deploy commit does not match the approved commit");
  return Object.freeze({ render: true, deployedCommit });
}

function assertReadinessGates(env = process.env) {
  if (
    String(env.V2_N5_RENDER_RUN_ENABLED || "") !== "0"
    || String(env.V2_N5_RENDER_REQUEST_BUDGET || "") !== "0"
    || String(env.V2_N5_RENDER_AUTOMATIC_RETRY || "") !== "0"
    || String(env.V2_N5_RENDER_FALLBACK || "") !== "0"
    || String(env.V2_N5_RENDER_OPERATIONAL_WRITES || "") !== "0"
  ) fail("V2_N5_RENDER_READINESS_GATE_INVALID", "Readiness safety gates must be explicitly disabled");
  const forbidden = [
    "V2_N5_RENDER_LIVE_APPROVED",
    "V2_N5_RENDER_APPROVED_JOB_SHA256",
    "V2_NAVER_ROOM_MARKER_LIVE_APPROVED",
    "V2_NAVER_ROOM_MARKER_REQUEST_BUDGET",
    "V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256"
  ];
  if (forbidden.some((name) => String(env[name] || "").trim())) {
    fail("V2_N5_RENDER_READINESS_GATE_INVALID", "Readiness must not contain a live execution gate");
  }
  return true;
}

function stateRoot(env = process.env) {
  const configured = String(env.V2_N5_RENDER_STATE_DIR || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    fail("V2_N5_RENDER_STATE_INVALID", "An absolute isolated state path is required");
  }
  if (String(env.RENDER_SERVICE_ID || "").trim()) {
    if (configured.replace(/\\/gu, "/") !== RENDER_STATE_ROOT) {
      fail("V2_N5_RENDER_STATE_INVALID", "Render state path must use the dedicated disk");
    }
    return RENDER_STATE_ROOT;
  }
  const root = path.resolve(LOCAL_STATE_ROOT);
  const resolved = path.resolve(configured);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_N5_RENDER_STATE_INVALID", "Local state path must be an isolated child of the N5-D4 output root");
  }
  return resolved;
}

async function verifyFileIdentities() {
  const result = {};
  for (const identity of FILE_IDENTITIES) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(ROOT, identity.path));
    } catch {
      fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "A required source file is unavailable");
    }
    const actual = identity.algorithm === "git-blob" ? gitBlobSha(bytes) : sha256(bytes);
    if (actual !== identity.expected) {
      fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "A required source file identity changed");
    }
    result[identity.key] = actual;
  }
  return Object.freeze(result);
}

async function verifyIntegrity(env = process.env) {
  if (process.version !== EXPECTED_NODE_VERSION) {
    fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "Node runtime identity changed");
  }
  const [jobIdentity, files] = await Promise.all([
    readFreshJob(),
    verifyFileIdentities()
  ]);
  const deploy = verifyRenderDeployIdentity(env);
  return Object.freeze({
    baselineCommit: BASELINE_COMMIT,
    deployedCommit: deploy.deployedCommit,
    render: deploy.render,
    nodeVersion: process.version,
    jobRunId: jobIdentity.job.runId,
    jobCanonicalSha256: jobIdentity.digest,
    ...files
  });
}

async function readiness(env = process.env) {
  assertReadinessGates(env);
  stateRoot(env);
  const integrity = await verifyIntegrity(env);
  return Object.freeze({
    schemaVersion: READINESS_SCHEMA_VERSION,
    event: READINESS_EVENT,
    status: "ready",
    mode: "readiness-only",
    runEnabled: false,
    requestBudget: 0,
    externalRequests: 0,
    collectorInvocations: 0,
    operationalWrites: 0,
    diagnosticStateWrites: 0,
    rawProviderResponseStored: false,
    automaticRetry: false,
    fallback: false,
    liveExecutionAvailable: false,
    baselineCommit: integrity.baselineCommit,
    deployedCommit: integrity.deployedCommit,
    nodeVersion: integrity.nodeVersion,
    jobRunId: integrity.jobRunId,
    jobCanonicalSha256: integrity.jobCanonicalSha256,
    runnerBlob: integrity.runnerBlob,
    contractBlob: integrity.contractBlob,
    currentCollectorBlob: integrity.currentCollectorBlob,
    frozenCollectorBlob: integrity.frozenCollectorBlob,
    packageLockSha256: integrity.packageLockSha256
  });
}

function holdUntilSignal({
  signalTarget = process,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = PROCESS_KEEPALIVE_INTERVAL_MS
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const keepalive = setIntervalFn(() => {}, intervalMs);
    const finish = (signal) => {
      if (settled) return;
      settled = true;
      clearIntervalFn(keepalive);
      signalTarget.removeListener("SIGTERM", onSigterm);
      signalTarget.removeListener("SIGINT", onSigint);
      resolve(Object.freeze({ signal }));
    };
    const onSigterm = () => finish("SIGTERM");
    const onSigint = () => finish("SIGINT");
    signalTarget.once("SIGTERM", onSigterm);
    signalTarget.once("SIGINT", onSigint);
  });
}

function safeErrorProjection(error) {
  const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "V2_N5_RENDER_FAILED";
  return Object.freeze({
    schemaVersion: ERROR_SCHEMA_VERSION,
    event: "n5_room_provider_marker_render_readiness_failed",
    status: "failed",
    code,
    stage: "readiness",
    retryable: false,
    externalRequests: 0,
    collectorInvocations: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !new Set(["readiness", "serve"]).has(argv[0])) {
    fail("V2_N5_RENDER_COMMAND_INVALID", "usage: readiness|serve");
  }
  const result = await readiness(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (argv[0] === "serve") await holdUntilSignal();
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(safeErrorProjection(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_COMMIT,
  ERROR_SCHEMA_VERSION,
  EXPECTED_NODE_VERSION,
  FILE_IDENTITIES,
  JOB_CANONICAL_SHA256,
  JOB_PATH,
  JOB_RUN_ID,
  LOCAL_STATE_ROOT,
  PROCESS_KEEPALIVE_INTERVAL_MS,
  READINESS_EVENT,
  READINESS_SCHEMA_VERSION,
  RENDER_STATE_ROOT,
  V2N5RenderReadinessError,
  assertReadinessGates,
  canonicalGitTextBytes,
  gitBlobSha,
  holdUntilSignal,
  main,
  readFreshJob,
  readiness,
  safeErrorProjection,
  sha256,
  stateRoot,
  verifyFileIdentities,
  verifyIntegrity,
  verifyRenderDeployIdentity
};
