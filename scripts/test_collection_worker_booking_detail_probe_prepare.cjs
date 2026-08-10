"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCollectionJobStore } = require("./collection_job_store.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { createCollectionWorkerV2Top20Orchestrator } = require("./collection_worker_v2_top20_orchestrator.cjs");
const { sha256Hex, stableJson } = require("./collection_worker_v2_top20_protocol.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail probe prepare fixtures" });
const COMMIT = "a".repeat(40);
let now = new Date("2026-08-11T00:00:00.000Z");
const contract = Object.freeze({
  keyword: "Synthetic lodging", searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all",
  checkIn: "2026-08-23", checkOut: "2026-08-23", bookingRangeDays: 1, rankStart: 1, rankEnd: 50, detailRankStart: 1, detailRankEnd: 20
});

function keyBase64(key, type) {
  return key.export({ format: "der", type }).toString("base64");
}

function targetFixture() {
  const target = {
    placeId: "1001", historicalBookingBusinessId: "2001", sourceRunId: "synthetic-run", verifiedAt: "2026-08-10T00:00:00.000Z",
    knownBookingItems: true, knownDailySchedule: true
  };
  return Object.freeze({ ...target, targetIdentityHash: sha256Hex(stableJson(target)) });
}

async function openProvider(store) {
  const initial = await store.read();
  const reserved = await store.beginAttempt({ expectedWorkflowRevision: initial.workflowRevision, explicit: true, now });
  await store.recordBlock({
    expectedWorkflowRevision: reserved.state.workflowRevision,
    failure: { subtype: "challenge_html", diagnosticId: null },
    now
  });
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "booking-detail-probe-prepare-"));
  try {
    const dispatch = crypto.generateKeyPairSync("ed25519");
    const request = crypto.generateKeyPairSync("ed25519");
    const artifact = crypto.generateKeyPairSync("ed25519");
    const jobStore = createCollectionJobStore({ runtimeRoot: root });
    const mainStore = createNaverProviderHealthStore({ filePath: path.join(root, "providers", "main.json"), runtimeRoot: root, now: () => now });
    const detailStore = createNaverProviderHealthStore({ filePath: path.join(root, "providers", "detail.json"), runtimeRoot: root, now: () => now });
    await openProvider(detailStore);
    now = new Date("2026-08-11T01:00:00.000Z");
    const orchestrator = createCollectionWorkerV2Top20Orchestrator({
      enabled: true,
      externalCallApproved: true,
      previewWriteApproved: true,
      targetWorkerCommit: COMMIT,
      jobStore,
      providerStore: mainStore,
      detailProviderStore: detailStore,
      dispatchPrivateKeyBase64: keyBase64(dispatch.privateKey, "pkcs8"),
      requestPublicKeyBase64: keyBase64(request.publicKey, "spki"),
      artifactPublicKeyBase64: keyBase64(artifact.publicKey, "spki"),
      now: () => new Date(now),
      async applyReadyTransaction() { return { committed: true, writeCount: 1 }; }
    });
    const target = targetFixture();
    const input = {
      trustedAdmin: true,
      contract,
      executionRequestId: `booking-detail-probe:2:${target.targetIdentityHash.slice(0, 12)}:${COMMIT.slice(0, 12)}`,
      bookingDetailProbeTarget: target,
      provenance: { sourceRoute: "/fixture", sourceRole: "admin", actorKind: "operator", collectorBackend: "v2_top20_worker" }
    };
    const prepared = await orchestrator.prepareBookingDetailRecoveryProbeTrustedAdmin(input);
    assert.equal(prepared.status, "queued");
    assert.match(prepared.jobId, /^job-booking-detail-probe-[a-f0-9]{12}-[a-f0-9]{12}$/u);
    assert.equal(prepared.maximumProviderCalls, 3);
    assert.equal(orchestrator.status().activePayloadCount, 1);
    assert.equal((await jobStore.readSnapshot()).jobs.length, 1);
    assert.equal((await detailStore.read()).state, "probe_allowed");
    const reused = await orchestrator.prepareBookingDetailRecoveryProbeTrustedAdmin(input);
    assert.equal(reused.reused, true);
    assert.equal((await jobStore.readSnapshot()).jobs.length, 1);
    await detailStore.releaseAttempt({ expectedWorkflowRevision: (await detailStore.read()).workflowRevision, now });
    assert.equal((await detailStore.read()).state, "open");
    assert.equal(guard.blockedAttempts(), 0);
    console.log("booking-detail probe prepare fixtures passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  throw error;
});
