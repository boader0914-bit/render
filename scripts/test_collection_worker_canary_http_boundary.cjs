"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildCollectionArtifactBundle } = require("./collection_artifact_contract.cjs");
const {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  buildSignedWorkerRequest,
  sha256Hex
} = require("./collection_worker_auth.cjs");
const {
  COLLECTION_WORKER_RESULT_SCHEMA_VERSION
} = require("./collection_worker_runtime.cjs");
const {
  CLAIM_PATH,
  COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
  COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX,
  COLLECTION_WORKER_CANARY_WORKER_ID,
  COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
  FAILURE_PATH,
  FINALIZE_PATH,
  OPERATOR_TOKEN_HEADER,
  PREFLIGHT_PATH,
  PREPARE_PATH,
  buildArtifactKeyProof,
  stableJson
} = require("./collection_worker_canary_protocol.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(__dirname, "glamping_app_server.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs").replace(/\\/gu, "/");
const COMMIT = "b".repeat(40);
const OPERATOR_TOKEN = "fixture-http-operator-token-with-more-than-thirty-two-characters";

function privateBase64(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function publicBase64(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function canaryContract(keyword) {
  return {
    keyword,
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 3
  };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnServer(port, runtimeRoot, keySet) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      RENDER: "",
      RENDER_SERVICE_NAME: "",
      RENDER_EXTERNAL_URL: "",
      RENDER_EXTERNAL_HOSTNAME: "",
      V2_PREVIEW_DATA_ROOT: runtimeRoot,
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: "canary-http-admin",
      GLAMPING_ADMIN_PASSWORD: "CanaryHttpFixture!123",
      GLAMPING_B2B_ENABLED: "0",
      COLLECTION_WORKER_CANARY_ENABLED: "true",
      COLLECTION_WORKER_TARGET_COMMIT: COMMIT,
      COLLECTION_WORKER_DISPATCH_PRIVATE_KEY_B64: privateBase64(keySet.dispatch.privateKey),
      COLLECTION_WORKER_ARTIFACT_PUBLIC_KEY_B64: publicBase64(keySet.artifact.publicKey),
      COLLECTION_WORKER_REQUEST_PUBLIC_KEY_B64: publicBase64(keySet.request.publicKey),
      COLLECTION_WORKER_OPERATOR_TOKEN_SHA256: crypto.createHash("sha256").update(OPERATOR_TOKEN).digest("hex"),
      NAVER_CLIENT_ID: "",
      NAVER_CLIENT_SECRET: "",
      NAVER_SEARCHAD_API_KEY: "",
      NAVER_SEARCHAD_SECRET_KEY: "",
      NAVER_SEARCHAD_CUSTOMER_ID: "",
      NODE_OPTIONS: `--require=${NETWORK_GUARD_PRELOAD}`
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-8000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, server) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`fixture server exited (${server.child.exitCode}): ${JSON.stringify(server.output())}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`fixture server health timeout: ${JSON.stringify(server.output())}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill();
  await exited;
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const target = new URL(pathname, baseUrl);
  assert.equal(target.origin, baseUrl);
  const response = await fetch(target, options);
  const text = await response.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { response, body };
}

function signedRequest(pathname, body, privateKey) {
  return buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
    method: "POST",
    path: pathname,
    scope: ALLOWED_PATH_SCOPES[pathname],
    issuedAt: new Date(),
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: sha256Hex(stableJson(body))
  }, { privateKey });
}

async function signedPost(baseUrl, pathname, body, privateKey, signedPath = pathname) {
  return jsonRequest(baseUrl, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedRequest: signedRequest(signedPath, body, privateKey), body })
  });
}

async function prepare(baseUrl, keyword) {
  return jsonRequest(baseUrl, PREPARE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [OPERATOR_TOKEN_HEADER]: OPERATOR_TOKEN
    },
    body: JSON.stringify(canaryContract(keyword))
  });
}

function proofBody(claimed, keySet) {
  const job = claimed.job;
  const runtimeId = `${COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX}${COMMIT.slice(0, 12)}`;
  const input = {
    jobId: job.signedJob.jobId,
    attemptId: job.signedJob.attemptId,
    workflowRevision: job.workflowRevision,
    workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
    workerCommit: COMMIT,
    runtimeId,
    contractHash: job.signedJob.contractHash,
    executionIdentityHash: job.signedJob.executionIdentityHash
  };
  return {
    jobId: input.jobId,
    attemptId: input.attemptId,
    workflowRevision: input.workflowRevision,
    workerCommit: COMMIT,
    runtimeId,
    artifactKeyProof: buildArtifactKeyProof(input, keySet.artifact.privateKey)
  };
}

function readyArtifact(claimed, keySet) {
  const job = claimed.job;
  const summary = {
    schemaVersion: COLLECTION_WORKER_RESULT_SCHEMA_VERSION,
    contractHash: job.signedJob.contractHash,
    executionIdentityHash: job.signedJob.executionIdentityHash,
    status: "ready",
    providerAttemptCount: 1,
    executedCallCount: 1,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0,
    organicCount: 50,
    adCount: 0,
    observedRankCount: 50,
    providerFailureSubtype: null,
    diagnosticId: "crawl-abcdefabcdef"
  };
  return buildCollectionArtifactBundle({
    identity: {
      jobId: job.signedJob.jobId,
      attemptId: job.signedJob.attemptId,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      runtimeId: `${COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX}${COMMIT.slice(0, 12)}`,
      contractHash: job.signedJob.contractHash,
      executionIdentityHash: job.signedJob.executionIdentityHash
    },
    files: [{ path: "canary-summary.json", content: JSON.stringify(summary) }]
  }, {
    privateKey: keySet.artifact.privateKey,
    keyId: COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID
  });
}

async function runSuccessBoundary(root, keySet) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, root, keySet);
  try {
    await waitForHealth(baseUrl, server);
    const prepared = await prepare(baseUrl, "Synthetic HTTP canary lodging");
    assert.equal(prepared.response.status, 201);

    const claimBody = {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: COMMIT
    };
    const unsigned = await jsonRequest(baseUrl, CLAIM_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedRequest: {}, body: claimBody })
    });
    assert.ok([400, 401, 403].includes(unsigned.response.status));

    const wrongPath = await signedPost(baseUrl, CLAIM_PATH, claimBody, keySet.request.privateKey, FAILURE_PATH);
    assert.equal(wrongPath.response.status, 403, "a signature for another internal route must be rejected");

    const claimed = await signedPost(baseUrl, CLAIM_PATH, claimBody, keySet.request.privateKey);
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.body.status, "claimed");

    const preflight = await signedPost(
      baseUrl,
      PREFLIGHT_PATH,
      proofBody(claimed.body, keySet),
      keySet.request.privateKey
    );
    assert.equal(preflight.response.status, 200);
    assert.equal(preflight.body.status, "preflighted");

    const finalizeBody = {
      jobId: claimed.body.job.signedJob.jobId,
      attemptId: claimed.body.job.signedJob.attemptId,
      workflowRevision: claimed.body.job.workflowRevision,
      signedArtifact: readyArtifact(claimed.body, keySet)
    };
    const finalized = await signedPost(baseUrl, FINALIZE_PATH, finalizeBody, keySet.request.privateKey);
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.body.jobState, "validated_no_store");
    assert.equal(finalized.body.resultStored, false);
  } finally {
    await stopServer(server);
  }
}

async function runFailureBoundary(root, keySet, providerAttemptCount) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, root, keySet);
  try {
    await waitForHealth(baseUrl, server);
    assert.equal((await prepare(baseUrl, "Synthetic HTTP failure lodging")).response.status, 201);
    const claimBody = {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: COMMIT
    };
    const claimed = await signedPost(baseUrl, CLAIM_PATH, claimBody, keySet.request.privateKey);
    assert.equal(claimed.body.status, "claimed");
    const failureBody = {
      jobId: claimed.body.job.signedJob.jobId,
      attemptId: claimed.body.job.signedJob.attemptId,
      workflowRevision: claimed.body.job.workflowRevision,
      code: "COLLECTION_WORKER_CANARY_FIXTURE_FAILURE",
      providerAttemptCount
    };
    const failed = await signedPost(baseUrl, FAILURE_PATH, failureBody, keySet.request.privateKey);
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body.jobState, "failed");
    assert.equal(failed.body.providerAttemptCount, providerAttemptCount);
    assert.equal(failed.body.providerState, providerAttemptCount === 1 ? "open" : "closed");
    const replayed = await signedPost(baseUrl, FAILURE_PATH, failureBody, keySet.request.privateKey);
    assert.equal(replayed.response.status, 200);
    assert.equal(replayed.body.replayed, true);
  } finally {
    await stopServer(server);
  }
}

async function main() {
  const guard = installFixtureNetworkGuard({ allowLocalhost: true, label: "collection worker localhost HTTP boundary" });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-worker-http-"));
  const keySet = {
    dispatch: crypto.generateKeyPairSync("ed25519"),
    artifact: crypto.generateKeyPairSync("ed25519"),
    request: crypto.generateKeyPairSync("ed25519")
  };
  try {
    await runSuccessBoundary(path.join(tempRoot, "success"), keySet);
    await runFailureBoundary(path.join(tempRoot, "failure-before-provider"), keySet, 0);
    await runFailureBoundary(path.join(tempRoot, "failure-after-provider"), keySet, 1);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("Collection worker unauthenticated-browser, signed-service localhost HTTP boundary fixtures passed.");
  } finally {
    guard.restore();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected fixture directory: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
