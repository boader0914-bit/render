const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  projectCompanyMaster,
  projectPropertyObservations
} = require("./integration_preview_adapter.cjs");
const {
  contractDigest,
  sensitivePaths,
  sortObject
} = require("./integration_contracts.cjs");

const ROOT = path.resolve(__dirname, "..");
const STAGE222_FIXTURES = path.join(ROOT, "test", "fixtures", "stage222");
const STAGE223_FIXTURES = path.join(ROOT, "test", "fixtures", "stage223");
const SNAPSHOT_FILE = path.join(ROOT, "test", "snapshots", "stage223_integration_preview_snapshot.json");
const SERVER_FILE = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const FIXED_TIME = new Date("2026-07-19T00:00:00.000Z");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readFixtures() {
  return {
    companyMaster: await readJson(path.join(STAGE222_FIXTURES, "company_master_store.json")),
    collectionRun: await readJson(path.join(STAGE222_FIXTURES, "collection_run.json")),
    historyObservations: await readJson(path.join(STAGE223_FIXTURES, "history_observations.json"))
  };
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
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "manual"
  });
  const bodyText = await response.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }
  return {
    status: response.status,
    body,
    cookie: String(response.headers.get("set-cookie") || "").split(";")[0]
  };
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`preview server exited early (${child.exitCode})\n${logs.join("")}`);
    try {
      const response = await requestJson(baseUrl, "/api/health");
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`preview server did not become ready\n${logs.join("")}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileDigest(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function relativeFileList(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFileList(rootDir, entryPath));
    else files.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
  }
  return files.sort();
}

async function seedPreviewData(tempDir, fixtures) {
  const configDir = path.join(tempDir, "config");
  const companyDir = path.join(tempDir, "company_master");
  const historyDir = path.join(tempDir, "history");
  const outputsDir = path.join(tempDir, "outputs");
  const runDir = path.join(outputsDir, fixtures.collectionRun.runId);
  await Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(companyDir, { recursive: true }),
    fs.mkdir(historyDir, { recursive: true }),
    fs.mkdir(runDir, { recursive: true })
  ]);
  const files = {
    companyMaster: path.join(companyDir, "companies.json"),
    history: path.join(historyDir, "observations.jsonl"),
    manifest: path.join(runDir, "manifest.json"),
    output: path.join(runDir, "fixture_summary.csv")
  };
  const csv = [
    "name,region,rank_or_order,availableRooms,totalRooms,weeklyAvgReservationRate,price,url",
    "Fixture Stay,Fixture City,1,4,10,0.6,150000,https://example.invalid/stay/fixture-001"
  ].join("\n");
  await Promise.all([
    fs.writeFile(files.companyMaster, JSON.stringify(fixtures.companyMaster, null, 2)),
    fs.writeFile(files.history, `${fixtures.historyObservations.map((row) => JSON.stringify(row)).join("\n")}\n`),
    fs.writeFile(files.manifest, JSON.stringify(fixtures.collectionRun.manifest, null, 2)),
    fs.writeFile(files.output, `${csv}\n`)
  ]);
  await fs.utimes(runDir, FIXED_TIME, FIXED_TIME);
  return { configDir, outputsDir, files };
}

async function login(baseUrl, username, password) {
  const response = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { username, password }
  });
  assert.equal(response.status, 200);
  assert.ok(response.cookie);
  return response.cookie;
}

function assertSynthetic(value, label) {
  assert.deepEqual(sensitivePaths(value), [], `${label} exposed a sensitive contract key`);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("onrender.com"), false);
  assert.equal(serialized.includes("/var/data"), false);
}

async function main() {
  const fixtures = await readFixtures();
  for (const [name, fixture] of Object.entries(fixtures)) assertSynthetic(fixture, name);

  const fixtureDigestBefore = contractDigest(fixtures);
  const pureCompanies = projectCompanyMaster(fixtures.companyMaster);
  const pureObservations = projectPropertyObservations({
    master: fixtures.companyMaster,
    historyObservations: fixtures.historyObservations,
    runEntries: [{
      run: { id: fixtures.collectionRun.runId, ...fixtures.collectionRun.manifest },
      observedAt: FIXED_TIME.toISOString(),
      availability: fixtures.collectionRun.availability
    }]
  });
  assert.equal(contractDigest(fixtures), fixtureDigestBefore, "projection mutated an input fixture");
  assert.equal(pureCompanies.items.length, 1);
  assert.equal(pureCompanies.items[0].companyId, "cmp_fixture_001");
  assert.equal(pureObservations.items.length, 2);
  assert.deepEqual(new Set(pureObservations.items.map((item) => item.companyId)), new Set(["cmp_fixture_001"]));
  assert.deepEqual(
    new Set(pureObservations.items.map((item) => item.source)),
    new Set(["v2_history", "v2_run_output"])
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lodging-stage223-"));
  const { configDir, outputsDir, files } = await seedPreviewData(tempDir, fixtures);
  const beforeDigests = Object.fromEntries(await Promise.all(
    Object.entries(files).map(async ([name, filePath]) => [name, await fileDigest(filePath)])
  ));
  const beforeSourceFiles = await relativeFileList(tempDir);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
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
      GLAMPING_ADMIN_USER: "preview-admin",
      GLAMPING_ADMIN_PASSWORD: "PreviewAdmin!223",
      GLAMPING_B2B_USER: "preview-business",
      GLAMPING_B2B_PASSWORD: "PreviewBusiness!223",
      GLAMPING_B2B_ENABLED: "1",
      V2_INTEGRATION_COMPANY_ENABLED: "1",
      V2_INTEGRATION_OBSERVATION_ENABLED: "1",
      V2_INTEGRATION_PREVIEW_PURPOSE: "contract-preview",
      V2_INTEGRATION_PREVIEW_FIXTURE_ROOT: tempDir,
      V2_INTEGRATION_AUTH_ENABLED: "",
      V2_INTEGRATION_BUSINESS_REPORT_ENABLED: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForServer(baseUrl, child, logs);
    const b2bCookie = await login(baseUrl, "preview-business", "PreviewBusiness!223");
    const b2bCompany = await requestJson(baseUrl, "/api/integration-preview/companies", { cookie: b2bCookie });
    const b2bObservation = await requestJson(baseUrl, "/api/integration-preview/observations", { cookie: b2bCookie });
    assert.equal(b2bCompany.status, 403);
    assert.equal(b2bObservation.status, 403);

    const adminCookie = await login(baseUrl, "preview-admin", "PreviewAdmin!223");
    const company = await requestJson(baseUrl, "/api/integration-preview/companies?limit=10", { cookie: adminCookie });
    const observation = await requestJson(baseUrl, "/api/integration-preview/observations?limit=10&runLimit=10", { cookie: adminCookie });
    assert.equal(company.status, 200);
    assert.equal(observation.status, 200);
    assert.equal(company.body.projection.mode, "read_only");
    assert.equal(company.body.items[0].companyId, "cmp_fixture_001");
    assert.equal(observation.body.projection.mode, "read_only");
    assert.equal(observation.body.items.length, 2);
    assert.deepEqual(new Set(observation.body.items.map((item) => item.companyId)), new Set(["cmp_fixture_001"]));
    assertSynthetic(company.body, "company preview");
    assertSynthetic(observation.body, "observation preview");

    const afterDigests = Object.fromEntries(await Promise.all(
      Object.entries(files).map(async ([name, filePath]) => [name, await fileDigest(filePath)])
    ));
    assert.deepEqual(afterDigests, beforeDigests, "preview API modified a v2 source file");
    const afterSourceFiles = await relativeFileList(tempDir);
    const allowedRuntimeFiles = new Set([
      "customer_db/b2b_members.json"
    ]);
    const sourceFilesAfterRuntimeSetup = afterSourceFiles.filter((file) => !allowedRuntimeFiles.has(file));
    assert.deepEqual(
      sourceFilesAfterRuntimeSetup,
      beforeSourceFiles,
      "preview API created or removed a v2 source file"
    );

    const snapshot = sortObject({
      version: 1,
      access: {
        b2bCompanyStatus: b2bCompany.status,
        b2bObservationStatus: b2bObservation.status,
        adminCompanyStatus: company.status,
        adminObservationStatus: observation.status
      },
      sourceFilesUnchanged: JSON.stringify(afterDigests) === JSON.stringify(beforeDigests)
        && JSON.stringify(sourceFilesAfterRuntimeSetup) === JSON.stringify(beforeSourceFiles),
      company: company.body,
      observation: observation.body
    });
    if (process.env.UPDATE_INTEGRATION_PREVIEW_SNAPSHOT === "1") {
      await fs.mkdir(path.dirname(SNAPSHOT_FILE), { recursive: true });
      await fs.writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } else {
      const expected = await readJson(SNAPSHOT_FILE);
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

  console.log("Stage 223 integration preview adapter checks passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
