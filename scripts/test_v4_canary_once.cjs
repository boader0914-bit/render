const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const {
  EXPECTED_COLLECTOR_BLOB,
  gitBlobSha
} = require("./v4_worker_once.cjs");
const {
  CANARY_JOB_SCHEMA,
  CanaryError,
  executeCanary,
  publicFailure
} = require("./v4_canary_once.cjs");
const {
  CANARY_HOSTNAME,
  CANARY_PROVIDER,
  CanaryNetworkError,
  PROXY_ENV_NAMES,
  createCanaryTransport,
  normalizeDnsRecords,
  validateTargetUrl
} = require("./v4_canary_transport.cjs");
const { createOfflineCanaryTransport } = require("./fixtures/v4_canary_fixture_transport.cjs");

const ROOT = path.resolve(__dirname, "..");
const COLLECTOR = path.join(__dirname, "gyeongnam_glamping_crawl.cjs");
const CANARY = path.join(__dirname, "v4_canary_once.cjs");
const CANARY_HOST = path.join(__dirname, "v4_canary_host.cjs");
const BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const JOB_FILE = path.join(ROOT, "tests", "fixtures", "v4_canary_job.json");
const TEST_SECRET = "phase5-canary-private-secret-value";

function baseJob(suffix = "success") {
  return {
    schemaVersion: CANARY_JOB_SCHEMA,
    approvalId: `approval-${suffix}`,
    jobId: `canary-${suffix}`,
    idempotencyKey: `canary-key-${suffix}`,
    provider: CANARY_PROVIDER,
    keyword: "Gyeongnam glamping offline canary"
  };
}

function offlineEnv(job, overrides = {}) {
  return {
    V4_CANARY_MODE: "offline-test",
    V4_CANARY_APPROVAL_ID: job.approvalId,
    V4_CANARY_EXTERNAL_CALLS_ENABLED: "0",
    V4_CANARY_NETWORK_GATE_ENABLED: "0",
    V4_CANARY_OPERATIONAL_PUBLISH_ENABLED: "0",
    V4_CANARY_WEB_IMPORT_ENABLED: "0",
    V4_CANARY_PRIVATE_SECRET: TEST_SECRET,
    ...overrides
  };
}

function successResponse(body = null) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body || JSON.stringify({ total: 1, start: 1, display: 1, items: [{ title: "fixture" }] }))
  };
}

function transportWith(env, options = {}) {
  return createCanaryTransport({
    env,
    lookupFn: options.lookupFn || (async () => [{ address: "8.8.8.8", family: 4 }]),
    requestImpl: options.requestImpl || (async () => successResponse()),
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes
  });
}

async function assertRejectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function scanForSecret(root, secret) {
  if (!fs.existsSync(root)) return;
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const bytes = await fsp.readFile(target);
        assert.equal(bytes.includes(Buffer.from(secret)), false, `secret leaked into ${target}`);
      }
    }
  }
  await visit(root);
}

function waitForText(read, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const value = read();
      if (pattern.test(value)) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${pattern}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function main() {
  assert.equal(globalThis.__DATALAB_V4_NETWORK_BLOCKED__, true);
  assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-canary-"));

  try {
    const successJob = baseJob("success");
    const successEnv = offlineEnv(successJob);
    const successRoot = path.join(temp, "success-root");
    const successTransport = createOfflineCanaryTransport(successEnv);
    const first = await executeCanary(successJob, {
      env: successEnv,
      dataRoot: successRoot,
      transport: successTransport,
      allowOfflineFixture: true
    });
    assert.equal(first.status, "succeeded");
    assert.equal(first.requestCount, 1);
    assert.equal(first.operationalWrites, false);
    assert.equal(successTransport.requestCount, 1);
    const manifest = JSON.parse(await fsp.readFile(
      path.join(successRoot, "artifacts", first.artifactId, "manifest.json"),
      "utf8"
    ));
    assert.equal(manifest.collectorInvoked, false);
    assert.equal(manifest.collectorBlob, EXPECTED_COLLECTOR_BLOB);
    assert.equal(manifest.providerRequestCount, 1);
    assert.equal(manifest.rawProviderResponseStored, false);
    assert.equal(manifest.operationalPublish, false);
    assert.equal(manifest.webImport, false);
    assert.equal(manifest.databaseWrite, false);
    assert.equal(JSON.stringify(manifest).includes("Offline canary fixture"), false);

    const duplicate = await executeCanary(successJob, {
      env: successEnv,
      dataRoot: successRoot,
      transport: transportWith(successEnv),
      allowOfflineFixture: true
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.requestCount, 0);
    assert.equal((await fsp.readdir(path.join(successRoot, "artifacts"))).length, 1);

    assert.throws(() => validateTargetUrl("https://example.com/v1/search", CANARY_HOSTNAME), {
      code: "CANARY_HOSTNAME_FORBIDDEN"
    });
    assert.throws(() => validateTargetUrl("https://8.8.8.8/v1/search", CANARY_HOSTNAME), {
      code: "CANARY_DIRECT_IP_FORBIDDEN"
    });
    assert.throws(() => validateTargetUrl(`http://${CANARY_HOSTNAME}/v1/search`, CANARY_HOSTNAME), {
      code: "CANARY_HTTPS_REQUIRED"
    });
    assert.throws(() => normalizeDnsRecords([{ address: "127.0.0.1", family: 4 }]), {
      code: "CANARY_DNS_ADDRESS_FORBIDDEN"
    });
    assert.throws(() => normalizeDnsRecords([{ address: "10.0.0.1", family: 4 }]), {
      code: "CANARY_DNS_ADDRESS_FORBIDDEN"
    });
    assert.throws(() => normalizeDnsRecords([{ address: "169.254.10.2", family: 4 }]), {
      code: "CANARY_DNS_ADDRESS_FORBIDDEN"
    });
    assert.throws(() => normalizeDnsRecords([{ address: "::1", family: 6 }]), {
      code: "CANARY_DNS_ADDRESS_FORBIDDEN"
    });

    const request = { url: `https://${CANARY_HOSTNAME}/v1/search/local.json?query=fixture`, headers: {} };
    const redirectTransport = transportWith(successEnv, {
      requestImpl: async () => ({ statusCode: 302, headers: { location: "https://example.com/" }, body: Buffer.alloc(0) })
    });
    await assertRejectCode(redirectTransport.requestJson(request), "CANARY_REDIRECT_BLOCKED");

    let privateRequestCalled = false;
    const privateTransport = transportWith(successEnv, {
      lookupFn: async () => [{ address: "192.168.1.20", family: 4 }],
      requestImpl: async () => {
        privateRequestCalled = true;
        return successResponse();
      }
    });
    await assertRejectCode(privateTransport.requestJson(request), "CANARY_DNS_ADDRESS_FORBIDDEN");
    assert.equal(privateRequestCalled, false);

    const budgetTransport = transportWith(successEnv);
    await budgetTransport.requestJson(request);
    await assertRejectCode(budgetTransport.requestJson(request), "CANARY_REQUEST_BUDGET_EXCEEDED");

    const timeoutTransport = transportWith(successEnv, {
      requestImpl: async () => {
        throw new CanaryNetworkError("CANARY_REQUEST_TIMEOUT", "Provider request exceeded its timeout.");
      }
    });
    await assertRejectCode(timeoutTransport.requestJson(request), "CANARY_REQUEST_TIMEOUT");

    const oversizedTransport = transportWith(successEnv, {
      maxResponseBytes: 1024,
      requestImpl: async () => successResponse(JSON.stringify({
        total: 1,
        start: 1,
        display: 1,
        items: [],
        padding: "x".repeat(2048)
      }))
    });
    await assertRejectCode(oversizedTransport.requestJson(request), "CANARY_RESPONSE_TOO_LARGE");

    const providerErrorTransport = transportWith(successEnv, {
      requestImpl: async () => ({ statusCode: 503, headers: {}, body: Buffer.from(`service unavailable ${TEST_SECRET}`) })
    });
    await assertRejectCode(providerErrorTransport.requestJson(request), "CANARY_PROVIDER_HTTP_ERROR");

    const proxyTransport = transportWith({ ...successEnv, HTTPS_PROXY: "http://proxy.invalid" });
    await assertRejectCode(proxyTransport.requestJson(request), "CANARY_PROXY_ENV_FORBIDDEN");

    const partialJob = baseJob("partial");
    const partialEnv = offlineEnv(partialJob);
    const partialRoot = path.join(temp, "partial-root");
    await assertRejectCode(executeCanary(partialJob, {
      env: partialEnv,
      dataRoot: partialRoot,
      transport: createOfflineCanaryTransport(partialEnv),
      allowOfflineFixture: true,
      testFault: "after-stage-write"
    }), "CANARY_TEST_STAGE_FAILURE");
    assert.equal((await fsp.readdir(path.join(partialRoot, "artifacts"))).length, 0);
    assert.equal((await fsp.readdir(path.join(partialRoot, "work"))).length, 0);
    await assertRejectCode(executeCanary(partialJob, {
      env: partialEnv,
      dataRoot: partialRoot,
      transport: createOfflineCanaryTransport(partialEnv),
      allowOfflineFixture: true
    }), "CANARY_IDEMPOTENCY_PREVIOUS_FAILURE");

    for (const [name, value] of [["DATABASE_URL", "postgres://forbidden"], ["V4_WEB_IMPORT_URL", "https://forbidden.invalid"]]) {
      const blockedJob = baseJob(`blocked-${name.toLowerCase().replaceAll("_", "-")}`);
      const blockedEnv = offlineEnv(blockedJob, { [name]: value });
      const blockedTransport = createOfflineCanaryTransport(blockedEnv);
      await assertRejectCode(executeCanary(blockedJob, {
        env: blockedEnv,
        dataRoot: path.join(temp, `blocked-${name}`),
        transport: blockedTransport,
        allowOfflineFixture: true
      }), "CANARY_OPERATIONAL_ENV_FORBIDDEN");
      assert.equal(blockedTransport.requestCount, 0);
    }

    const leaked = publicFailure(
      new CanaryError("CANARY_TEST_SECRET", "test", `client_secret=${TEST_SECRET}`),
      "canary-redaction",
      successEnv
    );
    assert.equal(JSON.stringify(leaked).includes(TEST_SECRET), false);

    const cliRoot = path.join(temp, "cli-root");
    const cliEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !PROXY_ENV_NAMES.includes(name) && ![
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
      ].includes(name))
    );
    Object.assign(cliEnv, {
      V4_CANARY_MODE: "offline-test",
      V4_CANARY_APPROVAL_ID: "approval-d-offline-only",
      V4_CANARY_EXTERNAL_CALLS_ENABLED: "0",
      V4_CANARY_NETWORK_GATE_ENABLED: "0",
      V4_CANARY_OPERATIONAL_PUBLISH_ENABLED: "0",
      V4_CANARY_WEB_IMPORT_ENABLED: "0",
      V4_CANARY_DATA_DIR: cliRoot,
      V4_CANARY_PRIVATE_SECRET: TEST_SECRET
    });
    const cli = spawnSync(process.execPath, [
      "--require",
      BLOCKER,
      CANARY,
      "--offline-fixture=success",
      `--job-file=${JOB_FILE}`
    ], { cwd: ROOT, env: cliEnv, encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const lines = cli.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).status, "succeeded");
    assert.equal(cli.stdout.includes(TEST_SECRET), false);
    assert.equal(cli.stderr.includes(TEST_SECRET), false);

    const hostRoot = path.join(temp, "host-root");
    const hostEnv = {
      ...cliEnv,
      V4_CANARY_DATA_DIR: hostRoot
    };
    const host = spawn(process.execPath, ["--require", BLOCKER, CANARY_HOST, "--offline-fixture"], {
      cwd: ROOT,
      env: hostEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let hostStdout = "";
    let hostStderr = "";
    host.stdout.on("data", (chunk) => { hostStdout += chunk.toString("utf8"); });
    host.stderr.on("data", (chunk) => { hostStderr += chunk.toString("utf8"); });
    try {
      await waitForText(() => hostStdout, /"event":"canary_host_idle"/);
      assert.match(hostStdout, /"event":"canary_run_terminal"[^\n]*"status":"succeeded"/);
      assert.equal(hostStdout.includes(TEST_SECRET), false);
      assert.equal(hostStderr.includes(TEST_SECRET), false);
      assert.equal((await fsp.readdir(path.join(hostRoot, "artifacts"))).length, 1);
    } finally {
      const hostClosed = new Promise((resolve) => host.once("close", resolve));
      host.kill("SIGKILL");
      await hostClosed;
    }

    assert.equal(Object.keys(require.cache).some((file) => file.endsWith("glamping_app_server.cjs")), false);
    await scanForSecret(temp, TEST_SECRET);
    assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);
    process.stdout.write("V4 canary offline tests passed\n");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
