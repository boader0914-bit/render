"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertDeterministicProvider,
  createInsightsRuntime
} = require("./integration/bootstrap/insights_runtime.cjs");
const {
  createInsightsRepository
} = require("./integration/repositories/insights_store.cjs");
const {
  ROOT,
  assertZeroNetworkAttempts,
  createMockFreshLayer,
  networkAttempts,
  networkGuardEnvironment,
  startServer,
  stopServer,
  temporaryDirectory
} = require("./test_support/stage229_test_helpers.cjs");

const RUNTIME_FILES = [
  "scripts/integration/contracts/insights.cjs",
  "scripts/integration/services/insights_fixture_provider.cjs",
  "scripts/integration/repositories/insights_store.cjs",
  "scripts/integration/services/insights_service.cjs",
  "scripts/integration/http/insights_http.cjs",
  "scripts/integration/bootstrap/insights_runtime.cjs"
];
const UI_FILES = [
  "apps/web/src/reporting/stage229Client.ts",
  "apps/web/src/reporting/useStage229Workspace.ts",
  "apps/web/src/reporting/Stage229Pages.tsx"
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function errorCode(error) {
  return error?.code || "";
}

function assertSourceBoundary() {
  const runtimeSource = RUNTIME_FILES.map((filename) => `// ${filename}\n${read(filename)}`).join("\n");
  const publicSource = UI_FILES.map((filename) => `// ${filename}\n${read(filename)}`).join("\n");
  const providerSource = read("scripts/integration/services/insights_fixture_provider.cjs");
  const inspected = `${runtimeSource}\n${publicSource}\n${read("test/fixtures/stage229/signal_contract_v1.json")}\n${read("test/fixtures/stage229/location_forecast_cases_v1.json")}`;

  const highConfidenceSecret = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}|\bAIza[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\brnd_[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}|(?:postgres|postgresql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@)/;
  assert.doesNotMatch(inspected, highConfidenceSecret, "Stage 229 assets contain a high-confidence credential value");
  assert.doesNotMatch(
    runtimeSource,
    /process\.env\.(?:TOURISM|SEARCH|SNS|TREND|NAVER|KAKAO|GOOGLE|FACEBOOK|INSTAGRAM|OPENAI)_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/,
    "Stage 229 runtime must not read a real provider credential"
  );
  assert.doesNotMatch(providerSource, /require\(["'](?:node:)?(?:http|https|net|tls|dns|undici|axios)["']\)|\bfetch\s*\(/, "the fixture provider must not contain an outbound network client");
  assert.doesNotMatch(
    runtimeSource,
    /\b(?:migrate|migration|backfill|dualWrite|dual_write|copyLegacy|importLegacy)\s*\(/i,
    "Stage 229 runtime must not implement migration, backfill or dual-write"
  );
  assert.doesNotMatch(
    runtimeSource,
    /(?:readFile|readFileSync|copyFile|copyFileSync)\s*\([^\n]*(?:customer_db|company_master|tourism_data|[\\/]outputs[\\/])/i,
    "Stage 229 runtime must not read or copy a legacy path"
  );
  assert.doesNotMatch(
    `${runtimeSource}\n${publicSource}`,
    /\b(?:strategyRecommendation|strategyCard|executionPlan|monthlyActionPlan|kpiTarget|retrospective|nextMonthCandidate)\b/i,
    "Stage 230 strategy/execution/KPI/retrospective concepts must remain absent"
  );

  function filesBelow(directory) {
    const output = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) output.push(...filesBelow(target));
      else output.push(target);
    }
    return output;
  }
  const stage230Files = filesBelow(ROOT).filter((filename) => (
    !filename.includes(`${path.sep}.git${path.sep}`)
    && /stage230/i.test(path.relative(ROOT, filename))
  ));
  assert.deepEqual(stage230Files, [], "Stage 230 assets must not be implemented in Stage 229");
}

function assertPreloadDeniesEveryChannel() {
  const guardDir = temporaryDirectory("stage229-security-guard-selftest-");
  const guardLog = path.join(guardDir, "attempts.jsonl");
  const env = { ...process.env, ...networkGuardEnvironment(guardLog) };
  const cases = [
    "fetch('https://blocked.example.invalid/').then(()=>process.exit(2),e=>{if(e.code!=='STAGE229_OUTBOUND_NETWORK_FORBIDDEN')throw e;})",
    "try{require('node:http').get('http://blocked.example.invalid/');process.exit(2)}catch(e){if(e.code!=='STAGE229_OUTBOUND_NETWORK_FORBIDDEN')throw e}",
    "try{require('node:https').request('https://blocked.example.invalid/');process.exit(2)}catch(e){if(e.code!=='STAGE229_OUTBOUND_NETWORK_FORBIDDEN')throw e}"
  ];
  try {
    for (const source of cases) {
      const result = childProcess.spawnSync(process.execPath, ["-e", source], {
        cwd: ROOT,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const attempts = networkAttempts(guardLog);
    assert.deepEqual(attempts.map((row) => row.channel), ["fetch", "http.get", "https.request"]);
    assert.ok(attempts.every((row) => row.target.includes("blocked.example.invalid")));
  } finally {
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

async function assertRuntimeBoundary() {
  const freshRoot = temporaryDirectory("stage229-security-runtime-fresh-");
  const legacyRoot = temporaryDirectory("stage229-security-runtime-legacy-");
  const fresh = createMockFreshLayer();
  const env = {
    NODE_ENV: "test",
    V2_INTEGRATION_DATA_DIR: freshRoot,
    DATA_DIR: legacyRoot,
    CONFIG_DIR: path.join(legacyRoot, "config"),
    OUTPUTS_DIR: path.join(legacyRoot, "outputs"),
    V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture"
  };
  const authRuntime = {
    service: fresh.authService,
    http: {
      requestContext() { return {}; },
      sessionForRequest() { return null; }
    }
  };
  const freshRuntime = {
    repository: fresh.freshRepository,
    service: fresh.freshService,
    async diagnostics() { return { storeId: "fresh_store_stage228_security" }; }
  };
  let serial = 0;
  try {
    const runtime = createInsightsRuntime({
      env,
      projectRoot: ROOT,
      authRuntime,
      freshRuntime,
      capabilities: { reliability: true, locationCard: true, businessReport: true },
      send() {},
      async parseBody() { return {}; },
      clock: () => Date.parse("2026-07-29T00:00:00.000Z"),
      idFactory: () => `stage229security${String(++serial).padStart(6, "0")}`,
      legacyPaths: [legacyRoot, path.join(legacyRoot, "config"), path.join(legacyRoot, "outputs")]
    });
    for (const component of ["repository", "provider", "service", "http", "initialize", "diagnostics"]) {
      assert.ok(runtime[component], `runtime.${component} must exist before initialize`);
    }
    assert.deepEqual(runtime.contract, {
      stage: 229,
      providerId: "stage229-deterministic-signal-fixture",
      providerMode: "deterministic-fixture",
      dataBoundary: "fresh-integration-stage229-only",
      externalProviderCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    });
    const initialized = await runtime.initialize();
    assert.equal(initialized.ok, true);
    assert.equal(initialized.diagnostics.parentFreshStoreId, "fresh_store_stage228_security");
    const diagnostics = await runtime.diagnostics();
    for (const key of [
      "externalProviderCalls", "credentialReads", "legacyRuntimeReads", "legacyRuntimeCopies", "productionMutations"
    ]) {
      assert.equal(diagnostics[key], 0, `runtime boundary ${key}`);
    }
    assert.equal(diagnostics.provider.externalRequests, 0);
    assert.equal(diagnostics.provider.credentialReads, 0);
    assert.equal(diagnostics.repositoryFileCopies, 0);
    assert.equal(fs.readdirSync(legacyRoot).length, 0);
    assert.deepEqual(fs.readdirSync(freshRoot), ["stage229-insights"]);

    assert.throws(
      () => createInsightsRuntime({
        env: { ...env, V2_INTEGRATION_INSIGHTS_PROVIDER: "tourism-api" },
        projectRoot: ROOT,
        authRuntime,
        freshRuntime,
        send() {},
        async parseBody() { return {}; }
      }),
      (error) => errorCode(error) === "INSIGHTS_REAL_PROVIDER_FORBIDDEN"
    );
    assert.throws(
      () => assertDeterministicProvider({
        id: "stage229-deterministic-signal-fixture",
        kind: "deterministic-fixture",
        async collect() { return { signals: [] }; },
        diagnostics() { return { externalRequests: 1 }; }
      }),
      (error) => errorCode(error) === "INSIGHTS_PROVIDER_BOUNDARY_VIOLATION"
    );

    const unboundRoot = temporaryDirectory("stage229-security-unbound-");
    try {
      const unbound = createInsightsRepository({
        env: { ...env, V2_INTEGRATION_DATA_DIR: unboundRoot },
        projectRoot: ROOT,
        legacyPaths: [legacyRoot]
      });
      await assert.rejects(
        unbound.initialize(),
        (error) => errorCode(error) === "INSIGHTS_PARENT_STORE_REQUIRED",
        "a Stage 229 store must fail closed without its Stage 228 parent store ID"
      );
    } finally {
      fs.rmSync(unboundRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

async function assertChildServerHasZeroAttempts() {
  const dataDir = temporaryDirectory("stage229-security-server-auth-");
  const integrationDataDir = temporaryDirectory("stage229-security-server-fresh-");
  const guardDir = temporaryDirectory("stage229-security-server-guard-");
  const guardLog = path.join(guardDir, "attempts.jsonl");
  let server;
  try {
    server = await startServer({
      dataDir,
      integrationDataDir,
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      reliabilityFlag: true,
      locationCardFlag: true,
      businessReportFlag: true,
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture",
        TOURISM_API_KEY: "stage229-poison-must-never-be-read",
        SEARCH_API_SECRET: "stage229-poison-must-never-be-read",
        SNS_ACCESS_TOKEN: "stage229-poison-must-never-be-read"
      })
    });
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assertZeroNetworkAttempts(guardLog);
  } finally {
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

async function main() {
  assertSourceBoundary();
  assertPreloadDeniesEveryChannel();
  await assertRuntimeBoundary();
  await assertChildServerHasZeroAttempts();
  console.log("Stage 229 secret, network, provider, fresh-store, legacy-copy, production-mutation and Stage 230 exclusion checks passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
