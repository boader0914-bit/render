"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { createCollectionJobStore } = require("./collection_job_store.cjs");
const { createCollectionWorkerRunTransactionStore } = require("./collection_worker_run_transaction.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { createCollectionWorkerV2Top20Orchestrator } = require("./collection_worker_v2_top20_orchestrator.cjs");
const { runCollectionWorkerV2Top20, ENV } = require("./collection_worker_v2_top20_worker.cjs");
const { buildV2Top20FinalArtifactFiles } = require("./collection_worker_v2_top20_artifact.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_DIAGNOSTIC_PATH,
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID
} = require("./collection_worker_v2_top20_protocol.cjs");
const { FIXED_V2_WORKER_RUNTIME_FINGERPRINT } = require("./collection_worker_contract.cjs");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const NOW = new Date("2026-08-11T00:00:00.000Z");
const COMMIT = "9".repeat(40);
const guard = installFixtureNetworkGuard({ label: "V2 full actual-child pipeline fixture" });

function privateBase64(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function publicBase64(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-type") return "application/json; charset=utf-8";
        if (key === "content-length") return String(Buffer.byteLength(text));
        return null;
      }
    },
    async text() { return text; }
  };
}

function workerEnvironment(keys, root, auditFile) {
  return {
    ...process.env,
    RENDER: "true",
    RENDER_SERVICE_ID: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
    RENDER_GIT_COMMIT: COMMIT,
    NODE_ENV: "test",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require=${NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/")}`,
      `--require=${PRELOAD.replace(/\\/gu, "/")}`
    ].filter(Boolean).join(" "),
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: "success",
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
    [ENV.workerMode]: "v2_top20_once",
    [ENV.externalCalls]: "true",
    [ENV.resultWrites]: "true",
    [ENV.executionEnabled]: "true",
    [ENV.top20Enabled]: "true",
    [ENV.previewInternalBaseUrl]: "http://preview-internal:10000",
    [ENV.dispatchPublicKey]: publicBase64(keys.dispatch.publicKey),
    [ENV.artifactPrivateKey]: privateBase64(keys.artifact.privateKey),
    [ENV.requestPrivateKey]: privateBase64(keys.request.privateKey),
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0"
  };
}

function internalFetch(orchestrator, counters) {
  return async (url, options) => {
    const pathname = new URL(url).pathname;
    counters[pathname] = Number(counters[pathname] || 0) + 1;
    const body = JSON.parse(String(options?.body || "{}"));
    try {
      const result = pathname === COLLECTION_WORKER_V2_TOP20_CLAIM_PATH
        ? await orchestrator.claim(body)
        : pathname === COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH
          ? await orchestrator.preflight(body)
          : pathname === COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH
            ? await orchestrator.heartbeat(body)
            : pathname === COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH
              ? await orchestrator.finalize(body)
              : pathname === COLLECTION_WORKER_V2_TOP20_FAILURE_PATH
                ? await orchestrator.recordFailure(body)
                : pathname === COLLECTION_WORKER_V2_TOP20_ARTIFACT_DIAGNOSTIC_PATH
                  ? await orchestrator.recordArtifactSecurityDiagnostic(body)
                  : (() => {
                    const error = new Error("fixture internal endpoint is not recognized");
                    error.code = "FIXTURE_INTERNAL_NOT_FOUND";
                    error.statusCode = 404;
                    throw error;
                  })();
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ code: String(error?.code || "FIXTURE_INTERNAL_FAILURE") }, Number(error?.statusCode || 500));
    }
  };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-actual-pipeline-"));
  try {
    const keys = {
      dispatch: crypto.generateKeyPairSync("ed25519"),
      request: crypto.generateKeyPairSync("ed25519"),
      artifact: crypto.generateKeyPairSync("ed25519")
    };
    const jobStore = createCollectionJobStore({ runtimeRoot: root });
    const mainStore = createNaverProviderHealthStore({ filePath: path.join(root, "provider", "main.json"), runtimeRoot: root });
    const detailStore = createNaverProviderHealthStore({ filePath: path.join(root, "provider", "detail.json"), runtimeRoot: root });
    const transactionStore = createCollectionWorkerRunTransactionStore({ runtimeRoot: root });
    let transactionReceipt = null;
    let transactionFailure = null;
    let transactionCallbackResult = null;
    const orchestrator = createCollectionWorkerV2Top20Orchestrator({
      enabled: true,
      externalCallApproved: true,
      previewWriteApproved: true,
      targetWorkerCommit: COMMIT,
      jobStore,
      providerStore: mainStore,
      detailProviderStore: detailStore,
      dispatchPrivateKeyBase64: privateBase64(keys.dispatch.privateKey),
      requestPublicKeyBase64: publicBase64(keys.request.publicKey),
      artifactPublicKeyBase64: publicBase64(keys.artifact.publicKey),
      now: () => NOW,
      applyReadyTransaction: async (input) => {
        try {
          transactionReceipt = await transactionStore.finalizeVerifiedRunBundle({
            signedArtifact: input.signedArtifact,
            verifier: (candidate) => {
              assert.equal(candidate, input.signedArtifact, "the verified Artifact identity must be stable at transaction commit");
              return input.verifiedArtifact;
            }
          });
          assert.equal(transactionReceipt.state, "committed");
          assert.equal(transactionReceipt.outputValid, true);
          transactionCallbackResult = Object.freeze({
            receiptId: input.receiptId,
            committed: true,
            writeCount: transactionReceipt.fileCount
          });
          return transactionCallbackResult;
        } catch (error) {
          transactionFailure = { code: String(error?.code || "TRANSACTION_FAILURE") };
          throw error;
        }
      }
    });
    const contract = {
      keyword: "Synthetic V2 three-day lodging",
      searchMode: "keyword",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      checkIn: "2026-08-23",
      checkOut: "2026-08-25",
      bookingRangeDays: 3,
      rankStart: 1,
      rankEnd: 50,
      detailRankStart: 1,
      detailRankEnd: 20,
      clientRequestId: "fixture-v2-actual-child-pipeline-01"
    };
    const prepared = await orchestrator.prepareTrustedAdmin({ trustedAdmin: true, singleSource: true, contract });
    assert.equal(prepared.status, "queued");
    assert.match(prepared.jobId, /^job-v2-/u);
    assert.equal(prepared.maximumProviderCalls, 561);
    const counters = {};
    const auditFile = path.join(root, "provider-calls.json");
    let artifactFailure = null;
    let finalArtifactSummary = null;
    let result;
    try {
      result = await runCollectionWorkerV2Top20({
        fixtureMode: true,
        environment: workerEnvironment(keys, root, auditFile),
        internalFetchImpl: internalFetch(orchestrator, counters),
        now: NOW,
        runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
        tempBase: root,
        cwd: ROOT,
        artifactFinalizer: async (input) => {
          try {
            const finalized = buildV2Top20FinalArtifactFiles(input);
            finalArtifactSummary = finalized.summary;
            return finalized;
          } catch (error) {
            artifactFailure = { code: String(error?.code || "ARTIFACT_FAILURE") };
            throw error;
          }
        }
      });
    } catch (error) {
      if (artifactFailure) {
        assert.fail(`actual V2 child Artifact contract failed: ${artifactFailure.code}`);
      }
      if (transactionFailure) {
        assert.fail(`actual V2 child transaction failed: ${transactionFailure.code}`);
      }
      if (finalArtifactSummary) {
        assert.fail(`actual V2 child Artifact final validation failed: ${JSON.stringify({
          schemaVersion: finalArtifactSummary.schemaVersion,
          status: finalArtifactSummary.status,
          collectionStatus: finalArtifactSummary.collectionStatus,
          executedCallCount: finalArtifactSummary.executedCallCount,
          providerWorkflowRevision: finalArtifactSummary.providerWorkflowRevision,
          automaticRetry: finalArtifactSummary.automaticRetry,
          automaticFallback: finalArtifactSummary.automaticFallback,
          executionState: finalArtifactSummary.executionState
        })}`);
      }
      throw error;
    }
    if (result.status !== "ready") {
      assert.fail(`actual V2 child finalization did not commit: ${JSON.stringify({
        status: result.status,
        jobState: result.jobState,
        failureCode: result.failureCode || "",
        callbackReceiptIdPresent: Boolean(transactionCallbackResult?.receiptId),
        callbackCommitted: transactionCallbackResult?.committed === true,
        callbackWriteCount: transactionCallbackResult?.writeCount ?? null,
        transactionFileCount: transactionReceipt?.fileCount ?? null,
        transactionState: transactionReceipt?.state || "",
        transactionFailureCode: transactionFailure?.code || "",
        artifactStatus: finalArtifactSummary?.status || "",
        artifactCollectionStatus: finalArtifactSummary?.collectionStatus || "",
        artifactFailureCode: finalArtifactSummary?.failureCode || ""
      })}`);
    }
    assert.equal(result.jobState, "committed");
    assert.equal(result.resultStored, true);
    assert.ok(result.executedCallCount > 1, "the actual V2 child must perform the full ranked-detail collection flow");
    assert.ok(result.executedCallCount <= 561);
    assert.ok(transactionReceipt, "the real run transaction must commit the Worker Artifact");
    const visible = await transactionStore.readVisibleState();
    assert.equal(visible.runs.length, 1);
    assert.equal(visible.runs[0].collectionStatus, "complete");
    const snapshot = await jobStore.readSnapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0].state, "committed");
    assert.equal((await mainStore.read()).state, "closed");
    assert.equal((await detailStore.read()).state, "closed");
    const audit = await fs.readFile(auditFile, "utf8");
    assert.equal(audit.includes("http"), false, "synthetic child audit must never contain a real request URL");
    assert.equal(guard.blockedAttempts(), 0, "full actual-child fixture must not use an external network path");
    console.log(JSON.stringify({
      actualV2ChildUsed: true,
      threeDayComplete: true,
      executedCallCount: result.executedCallCount,
      maximumProviderCalls: prepared.maximumProviderCalls,
      transactionCommitted: true,
      artifactSigned: true,
      externalNetworkCalls: 0,
      internalFinalizeCalls: counters[COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH] || 0
    }));
  } finally {
    guard.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
