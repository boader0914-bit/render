"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCollectionJobStore } = require("./collection_job_store.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { buildSignedWorkerRequest, COLLECTION_WORKER_AUTH_AUDIENCE, sha256Hex } = require("./collection_worker_auth.cjs");
const { buildV2Top20ArtifactKeyProof, stableJson, COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH, COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID, COLLECTION_WORKER_V2_TOP20_WORKER_ID, COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID } = require("./collection_worker_v2_top20_protocol.cjs");
const { createCollectionWorkerV2Top20Orchestrator, runtimeIdForCommit } = require("./collection_worker_v2_top20_orchestrator.cjs");
const { verifyTop20ExecutionPayload } = require("./collection_worker_v2_top20_worker.cjs");

const COMMIT = "f".repeat(40);
function privateBase64(key) { return key.export({ format: "der", type: "pkcs8" }).toString("base64"); }
function publicBase64(key) { return key.export({ format: "der", type: "spki" }).toString("base64"); }
function sign(pathname, body, key) {
  return buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
    method: "POST",
    path: pathname,
    scope: pathname === COLLECTION_WORKER_V2_TOP20_CLAIM_PATH ? "collection:claim" : "collection:preflight",
    issuedAt: "2026-08-11T00:00:00.000Z",
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: sha256Hex(stableJson(body))
  }, { privateKey: key });
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-single-source-pipeline-"));
  try {
    const keys = {
      dispatch: crypto.generateKeyPairSync("ed25519"),
      request: crypto.generateKeyPairSync("ed25519"),
      artifact: crypto.generateKeyPairSync("ed25519")
    };
    const jobStore = createCollectionJobStore({ runtimeRoot: root });
    const mainStore = createNaverProviderHealthStore({ filePath: path.join(root, "provider", "main.json"), runtimeRoot: root });
    const detailStore = createNaverProviderHealthStore({ filePath: path.join(root, "provider", "detail.json"), runtimeRoot: root });
    const blockedAt = new Date("2026-08-10T00:00:00.000Z");
    for (const store of [mainStore, detailStore]) {
      const initial = await store.read();
      const reservation = await store.beginAttempt({
        expectedWorkflowRevision: initial.workflowRevision,
        explicit: true,
        now: blockedAt
      });
      await store.recordBlock({
        expectedWorkflowRevision: reservation.state.workflowRevision,
        failure: { subtype: "challenge_html", diagnosticId: "crawl-aaaaaaaaaaaa" },
        outcomeReceiptHash: "a".repeat(64),
        now: blockedAt
      });
    }
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
      applyReadyTransaction: async () => ({ receiptId: "fixture", committed: true, writeCount: 1 }),
      now: () => new Date("2026-08-11T00:00:00.000Z")
    });
    const contract = {
      keyword: "Synthetic V2 worker request",
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
      clientRequestId: "fixture-v2-pipeline-request-01"
    };
    const dry = await orchestrator.prepareSingleSourceDryRunTrustedAdmin({ trustedAdmin: true, contract });
    assert.equal(dry.wouldCreate, true);
    assert.equal(dry.probeDependency, false);
    assert.equal(dry.providerCallCount, 0);
    assert.equal(dry.writeCount, 0);
    const prepared = await orchestrator.prepareTrustedAdmin({ trustedAdmin: true, singleSource: true, contract });
    assert.equal(prepared.status, "queued");
    assert.match(prepared.jobId, /^job-v2-/u);
    assert.equal(prepared.maximumProviderCalls, 561);
    const claimBody = { workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID, workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID, workerCommit: COMMIT };
    const claimed = await orchestrator.claim({ body: claimBody, signedRequest: sign(COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, claimBody, keys.request.privateKey) });
    assert.equal(claimed.status, "claimed");
    const execution = verifyTop20ExecutionPayload(claimed.job.executionPayload, claimed.job.signedJob);
    assert.equal(execution.executionProfile, "v2_collector_single_source.v2");
    assert.equal(execution.contract.checkOut, "2026-08-25");
    assert.equal(execution.maximumProviderCalls, 561);
    assert.equal(Object.hasOwn(claimed.job.executionPayload, "top20Contract"), false, "the normal signed range contract must not carry a reconstructed compatibility contract");
    assert.equal(execution.providerSession.circuitStateAtReservation, "open");
    assert.equal(execution.detailProviderSession.liveCallsAllowed, true);
    const runtimeId = runtimeIdForCommit(COMMIT);
    const proof = buildV2Top20ArtifactKeyProof({
      jobId: prepared.jobId,
      attemptId: claimed.job.signedJob.attemptId,
      workflowRevision: claimed.job.workflowRevision,
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      workerCommit: COMMIT,
      runtimeId,
      contractHash: claimed.job.signedJob.contractHash,
      executionIdentityHash: claimed.job.signedJob.executionIdentityHash,
      top20ContractHash: prepared.top20ContractHash
    }, keys.artifact.privateKey);
    const preflightBody = { jobId: prepared.jobId, attemptId: claimed.job.signedJob.attemptId, workflowRevision: claimed.job.workflowRevision, workerCommit: COMMIT, runtimeId, artifactKeyProof: proof };
    const preflight = await orchestrator.preflight({ body: preflightBody, signedRequest: sign(COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH, preflightBody, keys.request.privateKey) });
    assert.equal(preflight.status, "preflighted");
    const snapshot = await jobStore.readSnapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0].providerAttemptCount, 0);
    assert.equal(snapshot.jobs[0].executedCallCount, null);
    console.log("V2 full pipeline no-provider fixture passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
