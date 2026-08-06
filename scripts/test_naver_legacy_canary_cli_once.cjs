"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  apolloHtml,
  createApolloFixture
} = require("./naver_collector_fixture_factory.cjs");
const {
  NAVER_LEGACY_CANARY_PHASE,
  NAVER_LEGACY_CANARY_PLAN_VERSION,
  NAVER_LEGACY_CANARY_SCOPE,
  NAVER_LEGACY_CANARY_STRATEGY,
  NAVER_LEGACY_CANARY_STRATEGY_VERSION
} = require("./naver_legacy_canary_contract.cjs");
const {
  NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION,
  TARGET_PREVIEW_SERVICE_ID,
  buildLiveCanaryPlan
} = require("./naver_legacy_canary_once.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const {
  MAX_STDIN_BYTES,
  readBoundedStdin,
  runCliAction,
  runCliMain
} = require("./run_naver_legacy_canary_once.cjs");

const guard = installFixtureNetworkGuard({ label: "naver legacy canary CLI fixtures" });
const SCRIPT = path.join(__dirname, "run_naver_legacy_canary_once.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const SENTINEL_QUERY = "Synthetic CLI sentinel lodging";
const TARGET_COMMIT = "b".repeat(40);
const BASE_TIME = new Date("2026-08-06T04:00:00.000Z");
const CONTRACT = Object.freeze({
  keyword: SENTINEL_QUERY,
  searchMode: "keyword",
  rankStart: 1,
  rankEnd: 50,
  display: 50,
  regionKey: null,
  categoryKey: "glamping",
  measurementPeriod: null,
  currentQueryCandidates: Object.freeze([SENTINEL_QUERY]),
  legacyNaverQuery: SENTINEL_QUERY
});

function approval() {
  const plan = buildLiveCanaryPlan(CONTRACT);
  return {
    schemaVersion: NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION,
    targetServiceId: TARGET_PREVIEW_SERVICE_ID,
    targetCommit: TARGET_COMMIT,
    notBefore: new Date(BASE_TIME.getTime() - 1_000).toISOString(),
    expiresAt: new Date(BASE_TIME.getTime() + 5 * 60_000).toISOString(),
    planVersion: NAVER_LEGACY_CANARY_PLAN_VERSION,
    strategy: NAVER_LEGACY_CANARY_STRATEGY,
    strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
    phase: NAVER_LEGACY_CANARY_PHASE,
    collectorScope: NAVER_LEGACY_CANARY_SCOPE,
    expectedContractHash: plan.collectorPlan.contractHash,
    expectedExecutionIdentityHash: plan.executionIdentityHash,
    expectedWorkflowRevision: 0,
    maxProviderAttempts: 1,
    authorizedCallCount: 1,
    concurrency: 1,
    automaticRetry: false,
    automaticFallback: false,
    externalCallApproved: true,
    providerHealthWriteApproved: true,
    resultWriteApproved: false,
    saveResult: false
  };
}

function successBody() {
  return apolloHtml(createApolloFixture({
    query: CONTRACT.keyword,
    display: 50,
    items: [
      { id: "fixture-cli-a", name: "Fixture CLI A", roadAddress: "Fixture CLI road A" },
      { id: "fixture-cli-b", name: "Fixture CLI B", roadAddress: "Fixture CLI road B" }
    ]
  }).state);
}

function captureStream() {
  const chunks = [];
  return {
    chunks,
    write(value) {
      chunks.push(String(value));
      return true;
    }
  };
}

function fakeProviderStore() {
  return {
    read: async () => ({
      providerId: "naver_place_search",
      state: "closed",
      openedAt: null,
      retryAt: null,
      consecutiveBlocks: 0,
      lastFailureSubtype: null,
      lastDiagnosticId: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      cooldownPolicyVersion: "naver-place-cooldown-v1",
      workflowRevision: 0,
      updatedAt: BASE_TIME.toISOString(),
      schemaVersion: 1
    })
  };
}

(async () => {
  let fixtureRoot = null;
  try {
    const envelopeSource = JSON.stringify({ contract: CONTRACT, targetCommit: TARGET_COMMIT });
    const parsed = await readBoundedStdin(Readable.from([
      Buffer.from(`\ufeff${envelopeSource.slice(0, 17)}`, "utf8"),
      Buffer.from(`${envelopeSource.slice(17)}\r\n`, "utf8")
    ]));
    assert.equal(parsed.contract.keyword, SENTINEL_QUERY);
    await assert.rejects(
      () => readBoundedStdin(Readable.from([])),
      (error) => error?.code === "NAVER_LEGACY_CANARY_INPUT_REQUIRED"
    );
    await assert.rejects(
      () => readBoundedStdin(Readable.from(["x".repeat(MAX_STDIN_BYTES + 1)])),
      (error) => error?.code === "NAVER_LEGACY_CANARY_INPUT_TOO_LARGE"
    );
    await assert.rejects(
      () => readBoundedStdin(Readable.from(["not-json"])),
      (error) => error?.code === "NAVER_LEGACY_CANARY_INPUT_INVALID"
    );

    const plan = await runCliAction("plan", { contract: CONTRACT, targetCommit: TARGET_COMMIT }, {
      fixtureMode: true,
      environment: {},
      runtimeRoot: path.join(__dirname, "fixture-runtime-not-used"),
      runtimeIdentityValidator: () => true,
      providerStore: fakeProviderStore(),
      now: BASE_TIME
    });
    assert.equal(plan.status, "planned");
    assert.equal(plan.expectedWorkflowRevision, 0);
    assert.equal(plan.actualCallsEnabled, false);
    assert.equal(plan.executedCallCount, 0);
    assert.equal(JSON.stringify(plan).includes(SENTINEL_QUERY), false);

    await assert.rejects(
      () => runCliAction("execute", { contract: CONTRACT, approval: approval(), unexpected: true }, {}),
      (error) => error?.code === "NAVER_LEGACY_CANARY_INPUT_INVALID"
    );
    await assert.rejects(
      () => runCliAction("unknown", { contract: CONTRACT }, {}),
      (error) => error?.code === "NAVER_LEGACY_CANARY_ACTION_INVALID"
    );

    const ttyOutput = captureStream();
    const ttyExit = await runCliMain({
      argv: ["execute"],
      stdin: { isTTY: true },
      stdout: ttyOutput
    });
    assert.equal(ttyExit, 1);
    assert.equal(JSON.parse(ttyOutput.chunks.join("")).code, "NAVER_LEGACY_CANARY_STDIN_REQUIRED");

    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-cli-"));
    const providerStore = createNaverProviderHealthStore({
      filePath: path.join(fixtureRoot, "provider_health", "naver_place_search.json"),
      runtimeRoot: fixtureRoot,
      now: () => BASE_TIME
    });
    let executeCalls = 0;
    const successOutput = captureStream();
    const successExit = await runCliMain({
      argv: ["execute"],
      stdin: Readable.from([
        JSON.stringify({ contract: CONTRACT, approval: approval() }).slice(0, 37),
        `${JSON.stringify({ contract: CONTRACT, approval: approval() }).slice(37)}\n`
      ]),
      stdout: successOutput,
      fixtureMode: true,
      environment: {},
      runtimeRoot: fixtureRoot,
      runtimeIdentityValidator: () => true,
      providerStore,
      fetchImpl: async () => {
        executeCalls += 1;
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          text: async () => successBody()
        };
      },
      now: BASE_TIME,
      completedAt: new Date(BASE_TIME.getTime() + 2_000)
    });
    assert.equal(successExit, 0);
    assert.equal(executeCalls, 1);
    const successLines = successOutput.chunks.join("").trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(successLines.length, 1);
    const successResult = JSON.parse(successLines[0]);
    assert.equal(successResult.status, "ready");
    assert.equal(successResult.executedCallCount, 1);
    assert.equal(successResult.resultStored, false);
    assert.equal(successLines[0].includes(SENTINEL_QUERY), false);

    const child = spawnSync(process.execPath, [SCRIPT, "execute"], {
      cwd: path.dirname(__dirname),
      encoding: "utf8",
      input: JSON.stringify({ contract: CONTRACT, approval: { ...approval(), externalCallApproved: false } }),
      env: {
        ComSpec: process.env.ComSpec,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NODE_OPTIONS: `--require=${NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/")}`,
        RENDER: "false",
        NODE_ENV: "test",
        V2_PREVIEW_DATA_ROOT: ""
      }
    });
    assert.notEqual(child.status, 0);
    assert.notEqual(child.status, 97);
    const outputLines = String(child.stdout || "").trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(outputLines.length, 1);
    const safeOutput = JSON.parse(outputLines[0]);
    assert.equal(safeOutput.status, "failed");
    assert.equal(safeOutput.executedCallCount, 0);
    assert.equal(safeOutput.resultStored, false);
    assert.equal(String(child.stdout || "").includes(SENTINEL_QUERY), false);
    assert.equal(String(child.stderr || "").includes(SENTINEL_QUERY), false);

    const source = fs.readFileSync(SCRIPT, "utf8");
    assert.equal(source.includes("glamping_app_server"), false);
    assert.equal(source.includes("gyeongnam_glamping_crawl"), false);
    assert.equal(source.includes("child_process"), false);
    assert.equal(source.includes("fetch("), false);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("NAVER legacy canary CLI fixtures passed");
  } finally {
    if (fixtureRoot) await fsp.rm(fixtureRoot, { recursive: true, force: true });
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
