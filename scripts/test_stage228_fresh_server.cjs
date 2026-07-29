"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { totp } = require("./integration/services/auth_crypto.cjs");
const {
  ROOT,
  SERVER,
  TEST_KEYS,
  availablePort,
  bootstrapAdmin,
  requestJson,
  signupBusiness,
  startServer,
  stopServer
} = require("./test_stage227_helpers.cjs");

async function waitForJob(instance, jar, clientRequestId, expectedStatus = "completed", timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const statuses = new Set();
  while (Date.now() < deadline) {
    const response = await requestJson(
      instance,
      `/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}`,
      { jar }
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const status = response.body.job?.status || "";
    statuses.add(status);
    if (status === expectedStatus) return { response, statuses: [...statuses] };
    if (["completed", "cancelled", "failed"].includes(status) && status !== expectedStatus) {
      throw new Error(`job ${clientRequestId} reached ${status}, expected ${expectedStatus}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${clientRequestId} did not reach ${expectedStatus}; observed ${[...statuses].join(", ")}`);
}

function freshStoreDigest(root) {
  const digest = crypto.createHash("sha256");
  function walk(directory, relative = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".fresh-store.lock" || entry.name.endsWith(".tmp")) continue;
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `fresh store digest refuses symlink: ${childRelative}`);
      if (entry.isDirectory()) walk(absolute, childRelative);
      else if (entry.isFile()) {
        digest.update(childRelative);
        digest.update(fs.readFileSync(absolute));
      }
    }
  }
  walk(root);
  return digest.digest("hex");
}

async function startupFailure(options = {}) {
  const port = await availablePort();
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-startup-legacy-"));
  const freshDir = options.freshDir === "legacy"
    ? legacyDir
    : (options.freshDir || "");
  const child = childProcess.spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: legacyDir,
      OUTPUTS_DIR: path.join(legacyDir, "outputs"),
      CONFIG_DIR: path.join(legacyDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      V2_UI_V3_ENABLED: "true",
      V2_INTEGRATION_AUTH_ENABLED: "true",
      V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true",
      V2_INTEGRATION_FRESH_COMPANY_ENABLED: "true",
      V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true",
      V2_INTEGRATION_DATA_DIR: freshDir,
      V2_INTEGRATION_FRESH_PROVIDER: options.provider || "synthetic",
      V2_INTEGRATION_AUTH_STORE_PATH: options.legacyAuthStore
        ? path.join(legacyDir, "history", "legacy-auth-store.json")
        : (options.authStorePath || path.join(legacyDir, "fresh-integration", "auth-store.json")),
      V2_AUTH_BOOTSTRAP_SECRET: TEST_KEYS.bootstrap,
      V2_AUTH_SESSION_KEY_VERSION: "stage228-startup-v1",
      V2_AUTH_SESSION_HASH_KEY_CURRENT: TEST_KEYS.session,
      V2_AUTH_SESSION_HASH_KEYS_PREVIOUS: "{}",
      V2_AUTH_FINGERPRINT_KEY: TEST_KEYS.fingerprint,
      V2_AUTH_MFA_ENCRYPTION_KEY: TEST_KEYS.mfa,
      V2_AUTH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      V2_AUTH_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      V2_AUTH_EMAIL_PROVIDER: "mock"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Stage 228 startup did not fail closed")), 10_000))
    ]);
    assert.notEqual(child.exitCode, 0);
    assert.match(output, options.pattern);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
}

async function main() {
  await startupFailure({ pattern: /V2_INTEGRATION_DATA_DIR.*required/i });
  await startupFailure({ freshDir: "legacy", pattern: /overlap|legacy/i });
  const unapprovedProviderDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-unapproved-provider-"));
  try {
    await startupFailure({
      freshDir: unapprovedProviderDir,
      provider: "real",
      pattern: /real providers require explicit.*approval/i
    });
    await startupFailure({
      freshDir: unapprovedProviderDir,
      legacyAuthStore: true,
      pattern: /AUTH_STORE_PATH.*(?:inside DATA_DIR|legacy|namespace|overlap|forbidden)/i
    });
  } finally {
    fs.rmSync(unapprovedProviderDir, { recursive: true, force: true });
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-server-auth-"));
  const integrationDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-server-fresh-"));
  const legacyOutputDir = path.join(dataDir, "legacy-outputs-must-stay-unread");
  const legacyOutputName = "stage228-legacy-raw-sentinel.txt";
  const legacyOutputSentinel = "STAGE228_LEGACY_RAW_OUTPUT_MUST_NOT_BE_READ_OR_EXPOSED";
  fs.mkdirSync(legacyOutputDir, { recursive: true });
  fs.writeFileSync(path.join(legacyOutputDir, legacyOutputName), legacyOutputSentinel, "utf8");
  let instance;
  let admin;
  let businessOne;
  let businessTwo;
  const port = await availablePort();
  try {
    instance = await startServer({
      port,
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      uiFlag: true
    });
    admin = await bootstrapAdmin(instance, {
      username: "stage228-admin",
      email: "stage228-admin@example.test",
      password: "Stage228Admin!1"
    });
    const legacyOutputWithFreshFlagsOff = await requestJson(instance, `/outputs/${legacyOutputName}`, { jar: admin.jar });
    assert.equal(legacyOutputWithFreshFlagsOff.status, 200, "fresh flags off must preserve the legacy output route");
    assert.equal(legacyOutputWithFreshFlagsOff.text, legacyOutputSentinel);
    businessOne = await signupBusiness(instance, "one");
    businessTwo = await signupBusiness(instance, "two");
    const before = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(before.status, 200);

    await stopServer(instance, false); instance = null;
    instance = await startServer({
      port,
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      uiFlag: false,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: { V2_INTEGRATION_FRESH_PUMP_YIELD_MS: "100" }
    });
    const after = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(after.status, 200, "Stage 228 enablement must preserve the Stage 226 session");
    assert.equal(after.body.accountId, before.body.accountId);
    const blockedLegacyOutput = await requestJson(instance, `/outputs/${legacyOutputName}`, { jar: admin.jar });
    assert.equal(blockedLegacyOutput.status, 404, "fresh runtime must fail closed before reading legacy raw outputs");
    assert.equal(blockedLegacyOutput.text.includes(legacyOutputSentinel), false);
    const blockedEncodedLegacyOutput = await requestJson(instance, `/legacy/%2e%2e/outputs/${legacyOutputName}`, { jar: admin.jar });
    assert.equal(blockedEncodedLegacyOutput.status, 404, "encoded traversal must not bypass the fresh-only file boundary");
    assert.equal(blockedEncodedLegacyOutput.text.includes(legacyOutputSentinel), false);
    const legacyStaticDataPath = path.join(ROOT, "web", "data", "location_dictionary.json");
    assert.equal(fs.existsSync(legacyStaticDataPath), true, "legacy static data sentinel must exist for the regression");
    const blockedLegacyStaticData = await requestJson(instance, "/data/location_dictionary.json", { jar: admin.jar });
    assert.equal(blockedLegacyStaticData.status, 404, "fresh runtime must not serve legacy web/data files");
    const rollbackShellAsset = await requestJson(instance, "/app.js", { jar: admin.jar });
    assert.equal(rollbackShellAsset.status, 200, "non-data legacy UI assets remain available for explicit UI rollback");

    const empty = await requestJson(instance, "/api/integration/core/workspace?view=business-activity", { jar: businessOne.jar });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.metadata.stage, 228);
    assert.equal(empty.body.metadata.provisional, false);
    assert.equal(empty.body.metadata.providerCalls, 0);
    assert.equal(empty.body.metadata.legacyRuntimeReads, 0);
    assert.deepEqual(empty.body.companies, []);

    const noCsrf = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      csrf: false,
      body: { kind: "business-search", clientRequestId: "stage228-no-csrf-0001", keyword: "차단" }
    });
    assert.equal(noCsrf.status, 403);

    const request = {
      kind: "business-search",
      clientRequestId: "stage228-vertical-0001",
      keyword: "Stage 228 바다 글램핑",
      regionLabel: "경남"
    };
    const created = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST", jar: businessOne.jar, body: request
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.ok(["queued", "running"].includes(created.body.job.status));
    assert.ok(created.body.job.progress < 100);
    assert.equal(created.body.job.provisional, false);
    const replay = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST", jar: businessOne.jar, body: request
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.job.jobId, created.body.job.jobId);

    const completedFirst = await waitForJob(instance, businessOne.jar, request.clientRequestId);
    assert.equal(completedFirst.response.body.job.progress, 100);
    const recovered = await requestJson(instance, `/api/integration/core/jobs/${request.clientRequestId}`, { jar: businessOne.jar });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.job.status, "completed");

    const workspace = await requestJson(instance, "/api/integration/core/workspace?view=business-activity", { jar: businessOne.jar });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.companies.length, 1);
    const company = workspace.body.companies[0];
    assert.match(company.companyId, /^cmp_place_syn\d+$/);
    assert.equal(company.observationCount, 14);
    assert.equal(company.freshDetail.completeness.displayValue, "100%");
    assert.equal(company.freshDetail.provenance.sourceCount, 1);
    assert.equal(company.freshDetail.observations.repeatCount, 0);

    const tenantEscape = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}`, { jar: businessTwo.jar });
    assert.equal(tenantEscape.status, 403, "another tenant must not read a fresh company");
    const adminCompany = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}`, { jar: admin.jar });
    assert.equal(adminCompany.status, 200);

    const secondRun = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      body: { ...request, clientRequestId: "stage228-vertical-0002" }
    });
    assert.equal(secondRun.status, 202);
    assert.ok(["queued", "running"].includes(secondRun.body.job.status));
    await waitForJob(instance, businessOne.jar, "stage228-vertical-0002");
    const repeated = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}`, { jar: businessOne.jar });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.company.observationCount, 28);
    assert.equal(repeated.body.company.freshDetail.observations.repeatCount, 14);

    const cancellableId = "stage228-cancel-resume-0001";
    const cancellable = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      body: {
        kind: "business-search",
        clientRequestId: cancellableId,
        keyword: "Stage 228 취소 재개 글램핑",
        regionLabel: "경남"
      }
    });
    assert.equal(cancellable.status, 202);
    assert.ok(["queued", "running"].includes(cancellable.body.job.status));
    const cancelRequested = await requestJson(
      instance,
      `/api/integration/fresh/runs/${cancellableId}/cancel`,
      { method: "POST", jar: businessOne.jar, body: { reason: "server-acceptance-cancel" } }
    );
    assert.equal(cancelRequested.status, 200, JSON.stringify(cancelRequested.body));
    assert.equal(cancelRequested.body.job.cancelling, true);
    await waitForJob(instance, businessOne.jar, cancellableId, "cancelled");
    const resumed = await requestJson(
      instance,
      `/api/integration/fresh/runs/${cancellableId}/resume`,
      { method: "POST", jar: businessOne.jar, body: { reason: "server-acceptance-resume" } }
    );
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.ok(["queued", "running"].includes(resumed.body.job.status));
    await waitForJob(instance, businessOne.jar, cancellableId, "completed");

    const reviewWithoutStepUp = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}/review`, {
      method: "POST",
      jar: admin.jar,
      body: { decision: "approve", reason: "Stage 228 manual QA", profile: { primaryName: "검수 완료 바다 글램핑", region: "경남" } }
    });
    assert.equal(reviewWithoutStepUp.status, 403);
    assert.equal(reviewWithoutStepUp.body.reauthenticationRequired, true);
    const reauth = await requestJson(instance, "/api/auth/reauth", {
      method: "POST",
      jar: admin.jar,
      body: { password: admin.account.password, code: totp(admin.enrollment.body.secret, Date.now() + 30_000) }
    });
    assert.equal(reauth.status, 200, JSON.stringify(reauth.body));
    const review = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}/review`, {
      method: "POST",
      jar: admin.jar,
      body: {
        decision: "approve",
        reason: "Stage 228 manual QA",
        profile: { primaryName: "검수 완료 바다 글램핑", region: "경남", address: "경남 합성수집로 228" }
      }
    });
    assert.equal(review.status, 201, JSON.stringify(review.body));
    assert.equal(review.body.company.freshDetail.verifiedValues.length, 3);
    assert.ok(review.body.company.freshDetail.changes.length >= 1);

    const snapshot = await requestJson(instance, "/api/integration/fresh/snapshots", {
      method: "POST", jar: admin.jar, body: { label: "stage228-server-acceptance" }
    });
    assert.equal(snapshot.status, 201);
    assert.equal(snapshot.body.snapshot.snapshotKind, "fresh-integration-store-snapshot");
    const snapshots = await requestJson(instance, "/api/integration/fresh/snapshots", { jar: admin.jar });
    assert.equal(snapshots.status, 200);
    assert.equal(snapshots.body.snapshots.length, 1);

    const changedReview = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}/review`, {
      method: "POST",
      jar: admin.jar,
      body: {
        decision: "approve",
        reason: "Stage 228 snapshot rollback HTTP acceptance",
        profile: { primaryName: "rollback 전 임시 표시명", region: "경남", address: "경남 합성수집로 228" }
      }
    });
    assert.equal(changedReview.status, 201, JSON.stringify(changedReview.body));
    assert.equal(changedReview.body.company.companyName, "rollback 전 임시 표시명");
    const rolledBack = await requestJson(
      instance,
      `/api/integration/fresh/snapshots/${snapshot.body.snapshot.snapshotId}/rollback`,
      { method: "POST", jar: admin.jar, body: {} }
    );
    assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.body));
    const restoredCompany = await requestJson(instance, `/api/integration/fresh/companies/${company.companyId}`, { jar: admin.jar });
    assert.equal(restoredCompany.status, 200);
    assert.equal(restoredCompany.body.company.companyName, "검수 완료 바다 글램핑");

    const allPublicBodies = JSON.stringify([
      empty.body, created.body, workspace.body, repeated.body, review.body, snapshot.body, snapshots.body,
      changedReview.body, rolledBack.body, restoredCompany.body
    ]);
    assert.equal(allPublicBodies.includes(integrationDataDir), false);
    assert.equal(allPublicBodies.includes(dataDir), false);
    assert.doesNotMatch(allPublicBodies, /sourceUrl|rawEvidenceId|evidenceId|(?:[\\/]outputs[\\/]|customer_db|company_master)/i);
    for (const legacyName of ["history", "company_master", "customer_db", "tourism_data", "outputs"]) {
      assert.equal(fs.existsSync(path.join(integrationDataDir, legacyName)), false);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(integrationDataDir, "manifest.json"), "utf8"));
    assert.equal(manifest.storeKind, "glamping-datalab-v2-fresh-integration-store");
    assert.equal(Object.hasOwn(manifest, "sourceStoreHash"), false);

    await stopServer(instance, false); instance = null;
    instance = await startServer({
      port,
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      uiFlag: false,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: { V2_INTEGRATION_FRESH_PUMP_YIELD_MS: "1000" }
    });
    const restartClientRequestId = "stage228-process-restart-0001";
    const interrupted = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      body: {
        kind: "business-search",
        clientRequestId: restartClientRequestId,
        keyword: "Stage 228 재시작 복구 글램핑",
        regionLabel: "경남"
      }
    });
    assert.equal(interrupted.status, 202, JSON.stringify(interrupted.body));
    assert.ok(["queued", "running"].includes(interrupted.body.job.status));
    await stopServer(instance, false); instance = null;

    instance = await startServer({
      port,
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      uiFlag: false,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: { V2_INTEGRATION_FRESH_PUMP_YIELD_MS: "25" }
    });
    const recoveredSession = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(recoveredSession.status, 200, "process restart must preserve the issued auth session");
    const restartRecovered = await waitForJob(instance, businessOne.jar, restartClientRequestId, "completed", 30_000);
    assert.equal(restartRecovered.response.body.job.progress, 100);

    await stopServer(instance, false); instance = null;
    const freshDigestBeforeRollback = freshStoreDigest(integrationDataDir);
    instance = await startServer({
      port,
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      uiFlag: false
    });
    const rollbackSession = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(rollbackSession.status, 200, "fresh flag rollback must preserve the auth session");
    const rollbackWorkspace = await requestJson(instance, "/api/integration/core/workspace?view=business-activity", { jar: businessOne.jar });
    assert.equal(rollbackWorkspace.status, 200);
    assert.equal(rollbackWorkspace.body.metadata.stage, 227);
    assert.equal(rollbackWorkspace.body.metadata.provisional, true);
    assert.deepEqual(rollbackWorkspace.body.companies, []);
    const rollbackLegacyOutput = await requestJson(instance, `/outputs/${legacyOutputName}`, { jar: admin.jar });
    assert.equal(rollbackLegacyOutput.status, 200, "fresh flags off must restore the legacy output route");
    assert.equal(rollbackLegacyOutput.text, legacyOutputSentinel);
    const rollbackLegacyUi = await requestJson(instance, "/app.js", { jar: admin.jar });
    assert.equal(rollbackLegacyUi.status, 200, "fresh flags off must preserve legacy UI artifacts");
    await stopServer(instance, false); instance = null;
    assert.equal(
      freshStoreDigest(integrationDataDir),
      freshDigestBeforeRollback,
      "fresh flag rollback must not read-write or mutate the durable fresh store"
    );
    console.log("Stage 228 server, auth/CSRF/tenant, vertical slice, business-safe detail and snapshot checks passed");
  } finally {
    if (instance) await stopServer(instance, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
