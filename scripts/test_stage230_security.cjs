"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStrategyRuntime } = require("./integration/bootstrap/strategy_runtime.cjs");
const {
  ROOT,
  createMockStage230Dependencies,
  temporaryDirectory
} = require("./test_support/stage230_test_helpers.cjs");

const RUNTIME_FILES = Object.freeze([
  "scripts/integration/contracts/strategy_execution.cjs",
  "scripts/integration/repositories/strategy_store.cjs",
  "scripts/integration/services/strategy_service.cjs",
  "scripts/integration/http/strategy_http.cjs",
  "scripts/integration/bootstrap/strategy_runtime.cjs"
]);
const UI_FILES = Object.freeze([
  "apps/web/src/strategy/stage230Client.ts",
  "apps/web/src/strategy/useStage230Workspace.ts",
  "apps/web/src/strategy/Stage230Pages.tsx"
]);

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function assertStaticBoundary() {
  for (const relative of [...RUNTIME_FILES, ...UI_FILES]) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `missing Stage 230 source ${relative}`);
  }
  const runtime = RUNTIME_FILES.map((relative) => read(relative)).join("\n");
  const executableRuntime = RUNTIME_FILES.filter((relative) => !relative.includes("/contracts/")).map((relative) => read(relative)).join("\n");
  const inspected = [...RUNTIME_FILES, ...UI_FILES].map((relative) => read(relative)).join("\n");
  assert.doesNotMatch(runtime, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/, "Stage 230 runtime must not call a provider network primitive");
  assert.doesNotMatch(runtime, /require\(["']node:https?["']\)|require\(["']https?["']\)/, "Stage 230 runtime must not import an HTTP client");
  assert.doesNotMatch(runtime, /process\.env\.(?:NAVER|TOURISM|KTO|OTA|TREND|SNS|INSTAGRAM|FACEBOOK|GOOGLE|SERP)[A-Z0-9_]*/i, "Stage 230 must not read real provider credentials");
  assert.doesNotMatch(inspected, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}\b|\brnd_[A-Za-z0-9]{30,}\b/, "Stage 230 source contains a secret/private key token");
  assert.doesNotMatch(runtime, /\b(?:migration|backfill|dual[-_ ]?write)\b/i, "Stage 230 has no migration, backfill or dual-write path");
  assert.doesNotMatch(executableRuntime, /\b(?:customer_db|company_master|tourism_data|b2b_members|observations\.jsonl)\b/i, "Stage 230 must not name a legacy runtime store outside the business-safe deny matcher");
  assert.doesNotMatch(inspected, /\b(?:quotaScheduler|connectorAdapter|autoCalibration|recursiveReviewJob)\b/, "Stage 231 runtime concepts must remain absent");
  assert.match(runtime, /abWinner:\s*false/, "A/B automatic winner selection must remain explicitly disabled");
  assert.doesNotMatch(inspected, /https?:\/\/(?!example\.invalid)/i, "Stage 230 source must not embed an external endpoint");
}

async function assertRuntimeBoundary() {
  const freshRoot = temporaryDirectory("stage230-security-fresh-");
  const legacyRoot = temporaryDirectory("stage230-security-legacy-");
  try {
    const legacySentinel = path.join(legacyRoot, "legacy-data-must-not-be-read.json");
    fs.writeFileSync(legacySentinel, "{\"forbidden\":true}\n", "utf8");
    const dependencies = createMockStage230Dependencies();
    const insightsStoreId = "insights_stage230_security_parent";
    const runtime = createStrategyRuntime({
      env: {
        NODE_ENV: "test",
        V2_INTEGRATION_DATA_DIR: freshRoot,
        DATA_DIR: legacyRoot
      },
      projectRoot: ROOT,
      dataDir: freshRoot,
      legacyPaths: [legacyRoot],
      authRuntime: {
        service: {
          ...dependencies.authService,
          assertRequestBoundary() { return true; }
        },
        http: {
          requestContext() { return {}; },
          sessionForRequest() { return null; }
        }
      },
      freshRuntime: { service: dependencies.freshService },
      insightsRuntime: {
        service: dependencies.insightsService,
        capabilities: { businessReport: true },
        async diagnostics() {
          return {
            storeId: insightsStoreId,
            externalProviderCalls: 0,
            credentialReads: 0,
            legacyRuntimeReads: 0,
            legacyRuntimeCopies: 0,
            productionMutations: 0
          };
        }
      },
      capabilities: { strategy: true, execution: true, retrospective: true },
      send() {},
      async parseBody() { return {}; }
    });
    const initialized = await runtime.initialize();
    assert.equal(initialized.ok, true);
    assert.deepEqual(runtime.capabilities, { strategy: true, execution: true, retrospective: true });
    assert.deepEqual(runtime.contract, {
      stage: 230,
      ruleVersion: "v2-stage230-deterministic-strategy-v1",
      dataBoundary: "published-stage229-business-safe-only",
      externalProviderCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    });
    const diagnostics = await runtime.diagnostics();
    assert.equal(diagnostics.parentInsightsStoreId, insightsStoreId);
    for (const key of ["externalProviderCalls", "credentialReads", "legacyRuntimeReads", "legacyRuntimeCopies", "productionMutations"]) {
      assert.equal(diagnostics[key], 0, `${key} must remain zero`);
    }
    assert.equal(fs.readFileSync(legacySentinel, "utf8"), "{\"forbidden\":true}\n");
    assert.deepEqual(fs.readdirSync(legacyRoot), ["legacy-data-must-not-be-read.json"]);
    assert.ok(fs.existsSync(path.join(freshRoot, "stage230-strategy", "manifest.json")));
    assert.ok(fs.existsSync(path.join(freshRoot, "stage230-strategy", "state", "strategy-execution.json")));
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

async function main() {
  assertStaticBoundary();
  await assertRuntimeBoundary();
  console.log("Stage 230 secret, provider, legacy-data, Stage 231 deferral and runtime boundary checks passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
