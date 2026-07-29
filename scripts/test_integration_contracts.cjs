const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  INTEGRATION_FEATURE_DEFINITIONS,
  readIntegrationFeatureFlags
} = require("./integration_feature_flags.cjs");
const {
  contractDigest,
  contractShape,
  sensitivePaths,
  sortObject
} = require("./integration_contracts.cjs");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "stage222");
const SNAPSHOT_FILE = path.join(ROOT, "test", "snapshots", "stage222_contract_snapshot.json");
const SERVER_FILE = path.join(ROOT, "scripts", "glamping_app_server.cjs");

async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, name), "utf8"));
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {})
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "manual"
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: response.status,
    body,
    cookie: String(response.headers.get("set-cookie") || "").split(";")[0]
  };
}

async function waitForServer(baseUrl, child, logBuffer) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`contract server exited early (${child.exitCode})\n${logBuffer.join("")}`);
    }
    try {
      const response = await requestJson(baseUrl, "/api/health");
      if (response.status === 200) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`contract server did not become ready\n${logBuffer.join("")}`);
}

async function seedContractData(dataDir, fixtures) {
  const configDir = path.join(dataDir, "config");
  const companyDir = path.join(dataDir, "company_master");
  const customerDir = path.join(dataDir, "customer_db");
  const historyDir = path.join(dataDir, "history");
  const outputsDir = path.join(dataDir, "outputs");
  const runDir = path.join(outputsDir, fixtures.collectionRun.runId);
  await Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(companyDir, { recursive: true }),
    fs.mkdir(customerDir, { recursive: true }),
    fs.mkdir(historyDir, { recursive: true }),
    fs.mkdir(runDir, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(companyDir, "companies.json"), JSON.stringify(fixtures.companyMaster, null, 2)),
    fs.writeFile(path.join(configDir, "location_card_requests.json"), JSON.stringify(fixtures.locationRequests, null, 2)),
    fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(fixtures.collectionRun.manifest, null, 2)),
    fs.writeFile(path.join(runDir, "fixture_summary.csv"), "company,rank\nFixture Stay,1\n")
  ]);
  return { configDir, outputsDir };
}

async function assertPreviewFlagsFailClosed(fixtures, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `lodging-stage223-${options.label}-`));
  const { configDir, outputsDir } = await seedContractData(tempDir, fixtures);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const childLogs = [];
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: options.nodeEnv,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: tempDir,
      CONFIG_DIR: configDir,
      OUTPUTS_DIR: outputsDir,
      SEED_OUTPUTS_FROM_REPO: "0",
      RENDER: options.renderRuntime ? "true" : "",
      RENDER_EXTERNAL_URL: options.renderRuntime ? "https://contract-preview.invalid" : "",
      GLAMPING_ADMIN_USER: "contract-production-admin",
      GLAMPING_ADMIN_PASSWORD: "ContractProductionAdmin!224",
      GLAMPING_B2B_ENABLED: "0",
      V2_INTEGRATION_COMPANY_ENABLED: "true",
      V2_INTEGRATION_OBSERVATION_ENABLED: "true",
      V2_INTEGRATION_PREVIEW_PURPOSE: options.includeFixtureBoundary ? "contract-preview" : "",
      V2_INTEGRATION_PREVIEW_FIXTURE_ROOT: options.includeFixtureBoundary ? tempDir : "",
      V2_INTEGRATION_AUTH_ENABLED: "",
      V2_INTEGRATION_BUSINESS_REPORT_ENABLED: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
  child.stderr.on("data", (chunk) => childLogs.push(String(chunk)));

  try {
    await waitForServer(baseUrl, child, childLogs);
    const adminLogin = await requestJson(baseUrl, "/api/login", {
      method: "POST",
      body: {
        username: "contract-production-admin",
        password: "ContractProductionAdmin!224"
      }
    });
    assert.equal(adminLogin.status, 200);
    assert.ok(adminLogin.cookie, "production contract login must return a session cookie");

    const companyPreview = await requestJson(baseUrl, "/api/integration-preview/companies", {
      cookie: adminLogin.cookie
    });
    const observationPreview = await requestJson(baseUrl, "/api/integration-preview/observations", {
      cookie: adminLogin.cookie
    });
    const security = await requestJson(baseUrl, "/api/security-hardening", {
      cookie: adminLogin.cookie
    });

    assert.equal(companyPreview.status, 404, `company preview must fail closed for ${options.label}`);
    assert.equal(observationPreview.status, 404, `observation preview must fail closed for ${options.label}`);
    assert.equal(security.status, 200);
    if (options.expectFlagsDisabled) {
      assert.deepEqual(security.body.integration.flags, {
        company: false,
        observation: false,
        auth: false,
        businessReport: false
      });
      assert.equal(security.body.integration.state, "disabled");
      assert.equal(security.body.integration.enabledCount, 0);
    } else {
      assert.equal(security.body.integration.flags.company, true);
      assert.equal(security.body.integration.flags.observation, true);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function assertRedactedFixture(name, value) {
  const findings = sensitivePaths(value);
  assert.deepEqual(findings, [], `${name} contains sensitive contract paths: ${findings.join(", ")}`);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("onrender.com"), false, `${name} must not contain a live service URL`);
  assert.equal(serialized.includes("/var/data"), false, `${name} must not contain an operating disk path`);
}

async function main() {
  const fixtures = {
    apiContracts: await readFixture("api_contracts.json"),
    companyMaster: await readFixture("company_master_store.json"),
    collectionRun: await readFixture("collection_run.json"),
    b2bSession: await readFixture("b2b_session.json"),
    locationRequests: await readFixture("location_card_requests_store.json")
  };

  for (const [name, value] of Object.entries(fixtures)) assertRedactedFixture(name, value);
  assert.equal(Object.keys(fixtures.companyMaster.companies).length, 1);
  assert.equal(Object.keys(fixtures.locationRequests.requests).length, 1);
  assert.equal(fixtures.collectionRun.availability.items.length, 1);
  assert.equal(fixtures.b2bSession.role, "b2b");

  const expectedDefinitions = {
    auth: "V2_INTEGRATION_AUTH_ENABLED",
    businessReport: "V2_INTEGRATION_BUSINESS_REPORT_ENABLED",
    company: "V2_INTEGRATION_COMPANY_ENABLED",
    freshCompany: "V2_INTEGRATION_FRESH_COMPANY_ENABLED",
    freshObservation: "V2_INTEGRATION_FRESH_OBSERVATION_ENABLED",
    observation: "V2_INTEGRATION_OBSERVATION_ENABLED",
    platformCore: "V2_INTEGRATION_PLATFORM_CORE_ENABLED"
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(INTEGRATION_FEATURE_DEFINITIONS).map(([name, item]) => [name, item.envKey])),
    expectedDefinitions
  );
  assert.deepEqual(readIntegrationFeatureFlags({}), {
    company: false,
    observation: false,
    auth: false,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    NODE_ENV: "test",
    V2_INTEGRATION_COMPANY_ENABLED: "true",
    V2_INTEGRATION_OBSERVATION_ENABLED: "yes"
  }), {
    company: true,
    observation: true,
    auth: false,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    NODE_ENV: "production",
    V2_INTEGRATION_COMPANY_ENABLED: "true",
    V2_INTEGRATION_OBSERVATION_ENABLED: "true",
    V2_INTEGRATION_AUTH_ENABLED: "true",
    V2_INTEGRATION_BUSINESS_REPORT_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: true,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: true
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    NODE_ENV: "test",
    RENDER: "true",
    V2_INTEGRATION_COMPANY_ENABLED: "true",
    V2_INTEGRATION_OBSERVATION_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: false,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    NODE_ENV: "test",
    V2_INTEGRATION_AUTH_ENABLED: "true",
    V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: true,
    platformCore: true,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.platformCore.dependsOn, ["auth"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.freshCompany.dependsOn, ["auth", "platformCore"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.freshObservation.dependsOn, ["freshCompany"]);
  assert.deepEqual(readIntegrationFeatureFlags({
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: false,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    V2_INTEGRATION_FRESH_COMPANY_ENABLED: "true",
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: false,
    platformCore: false,
    freshCompany: false,
    freshObservation: false,
    businessReport: false
  });
  assert.deepEqual(readIntegrationFeatureFlags({
    V2_INTEGRATION_AUTH_ENABLED: "true",
    V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true",
    V2_INTEGRATION_FRESH_COMPANY_ENABLED: "true",
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true"
  }), {
    company: false,
    observation: false,
    auth: true,
    platformCore: true,
    freshCompany: true,
    freshObservation: true,
    businessReport: false
  });
  assert.equal(INTEGRATION_FEATURE_DEFINITIONS.company.scope, "test-only");
  assert.equal(INTEGRATION_FEATURE_DEFINITIONS.observation.scope, "test-only");
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.company.allowedEnvironments, ["test"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.observation.allowedEnvironments, ["test"]);

  const serverSource = await fs.readFile(SERVER_FILE, "utf8");
  for (const route of fixtures.apiContracts.routes) {
    assert.equal(serverSource.includes(route.path), true, `missing frozen route ${route.path}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lodging-stage222-"));
  const { configDir, outputsDir } = await seedContractData(tempDir, fixtures);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const childLogs = [];
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: tempDir,
      CONFIG_DIR: configDir,
      OUTPUTS_DIR: outputsDir,
      SEED_OUTPUTS_FROM_REPO: "0",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      GLAMPING_ADMIN_USER: "contract-admin",
      GLAMPING_ADMIN_PASSWORD: "ContractAdmin!222",
      GLAMPING_B2B_USER: "contract-business",
      GLAMPING_B2B_PASSWORD: "ContractBusiness!222",
      GLAMPING_B2B_ENABLED: "1",
      V2_INTEGRATION_COMPANY_ENABLED: "",
      V2_INTEGRATION_OBSERVATION_ENABLED: "",
      V2_INTEGRATION_AUTH_ENABLED: "",
      V2_INTEGRATION_BUSINESS_REPORT_ENABLED: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
  child.stderr.on("data", (chunk) => childLogs.push(String(chunk)));

  try {
    const health = await waitForServer(baseUrl, child, childLogs);
    const b2bLogin = await requestJson(baseUrl, "/api/login", {
      method: "POST",
      body: { username: "contract-business", password: "ContractBusiness!222" }
    });
    assert.equal(b2bLogin.status, 200);
    assert.ok(b2bLogin.cookie, "B2B login must return a session cookie");
    const b2bSession = await requestJson(baseUrl, "/api/session", { cookie: b2bLogin.cookie });
    const b2bCompanyDenied = await requestJson(baseUrl, "/api/company-master/summary", { cookie: b2bLogin.cookie });
    const b2bRuns = await requestJson(baseUrl, "/api/runs", { cookie: b2bLogin.cookie });

    const adminLogin = await requestJson(baseUrl, "/api/login", {
      method: "POST",
      body: { username: "contract-admin", password: "ContractAdmin!222" }
    });
    assert.equal(adminLogin.status, 200);
    assert.ok(adminLogin.cookie, "admin login must return a session cookie");
    const adminSession = await requestJson(baseUrl, "/api/session", { cookie: adminLogin.cookie });
    const runs = await requestJson(baseUrl, "/api/runs", { cookie: adminLogin.cookie });
    const companyMaster = await requestJson(baseUrl, "/api/company-master/summary", { cookie: adminLogin.cookie });
    const locationRequests = await requestJson(baseUrl, "/api/location-card-requests", { cookie: adminLogin.cookie });
    const security = await requestJson(baseUrl, "/api/security-hardening", { cookie: adminLogin.cookie });
    const disabledCompanyPreview = await requestJson(baseUrl, "/api/integration-preview/companies", { cookie: adminLogin.cookie });
    const disabledObservationPreview = await requestJson(baseUrl, "/api/integration-preview/observations", { cookie: adminLogin.cookie });

    assert.equal(health.status, 200);
    assert.equal(b2bSession.status, 200);
    assert.equal(b2bSession.body.role, "b2b");
    assert.equal(b2bCompanyDenied.status, 403);
    assert.deepEqual(b2bRuns.body, { runs: [] });
    assert.equal(adminSession.body.role, "admin");
    assert.equal(runs.body.runs.length, 1);
    assert.equal(companyMaster.body.totalCompanies, 1);
    assert.equal(locationRequests.body.items.length, 1);
    assert.equal(disabledCompanyPreview.status, 404);
    assert.equal(disabledObservationPreview.status, 404);
    assert.deepEqual(security.body.integration, {
      version: "stage222",
      state: "disabled",
      enabledCount: 0,
      flags: {
        company: false,
        observation: false,
        auth: false,
        businessReport: false
      }
    });

    for (const [name, value] of Object.entries({
      health: health.body,
      b2bSession: b2bSession.body,
      adminSession: adminSession.body,
      runs: runs.body,
      companyMaster: companyMaster.body,
      locationRequests: locationRequests.body
    })) {
      const findings = sensitivePaths(value);
      assert.deepEqual(findings, [], `${name} API response exposed sensitive paths: ${findings.join(", ")}`);
    }

    const snapshot = sortObject({
      version: 1,
      access: {
        b2bCompanyMasterStatus: b2bCompanyDenied.status,
        b2bRunCount: b2bRuns.body.runs.length,
        disabledCompanyPreviewStatus: disabledCompanyPreview.status,
        disabledObservationPreviewStatus: disabledObservationPreview.status
      },
      apiStatuses: {
        health: health.status,
        b2bSession: b2bSession.status,
        adminSession: adminSession.status,
        runs: runs.status,
        companyMaster: companyMaster.status,
        locationRequests: locationRequests.status,
        security: security.status
      },
      apiShapes: {
        health: contractShape(health.body),
        b2bSession: contractShape(b2bSession.body),
        adminSession: contractShape(adminSession.body),
        runs: contractShape(runs.body),
        companyMaster: contractShape(companyMaster.body),
        locationRequests: contractShape(locationRequests.body)
      },
      fixtureDigests: Object.fromEntries(
        Object.entries(fixtures).map(([name, value]) => [name, contractDigest(value)])
      ),
      fixtureShapes: Object.fromEntries(
        Object.entries(fixtures).map(([name, value]) => [name, contractShape(value)])
      ),
      integration: security.body.integration
    });

    if (process.env.UPDATE_CONTRACT_SNAPSHOTS === "1") {
      await fs.mkdir(path.dirname(SNAPSHOT_FILE), { recursive: true });
      await fs.writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } else {
      const expected = JSON.parse(await fs.readFile(SNAPSHOT_FILE, "utf8"));
      assert.deepEqual(snapshot, expected);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  await assertPreviewFlagsFailClosed(fixtures, {
    label: "production-even-with-fixture-boundary",
    nodeEnv: "production",
    includeFixtureBoundary: true,
    expectFlagsDisabled: true
  });
  await assertPreviewFlagsFailClosed(fixtures, {
    label: "render-runtime-even-with-test-env-and-fixture-boundary",
    nodeEnv: "test",
    includeFixtureBoundary: true,
    renderRuntime: true,
    expectFlagsDisabled: true
  });
  await assertPreviewFlagsFailClosed(fixtures, {
    label: "test-without-fixture-boundary",
    nodeEnv: "test",
    includeFixtureBoundary: false,
    expectFlagsDisabled: false
  });

  console.log("Stage 222 integration contract checks passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
