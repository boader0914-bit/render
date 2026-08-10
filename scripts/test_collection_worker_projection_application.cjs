"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  applicationHash,
  createCollectionWorkerProjectionApplicationStore,
  receiptFrom,
  validateReceipt
} = require("./collection_worker_projection_application.cjs");

const guard = installFixtureNetworkGuard({ label: "worker projection application fixtures" });
const root = path.join(os.tmpdir(), `worker-projection-application-${process.pid}-${Date.now()}`);
const transactionId = "a".repeat(64);
const receipt = receiptFrom({
  transactionId,
  runId: "preview-worker-run-0123456789abcdef0123",
  artifactHash: "b".repeat(64),
  projectionsHash: "c".repeat(64),
  collectionStatus: "complete",
  appliedAt: "2026-08-10T00:00:00.000Z",
  counts: {
    companyProjectionCount: 20,
    companyAppliedCount: 20,
    productProjectionCount: 20,
    productAppliedCount: 20,
    revenueProjectionCount: 20,
    revenueAppliedCount: 20,
    historyProjectionCount: 20,
    historyAppliedCount: 20
  }
});

(async () => {
  try {
    const store = createCollectionWorkerProjectionApplicationStore({ runtimeRoot: root });
    const first = await store.writeOnce(receipt);
    assert.equal(first.reused, false);
    const replay = await store.writeOnce(receipt);
    assert.equal(replay.reused, true);
    assert.deepEqual(await store.read(transactionId), receipt);
    const altered = { ...receipt, companyAppliedCount: 19 };
    altered.applicationHash = applicationHash(Object.fromEntries(Object.entries(altered).filter(([key]) => key !== "applicationHash")));
    await assert.rejects(() => store.writeOnce(altered), /conflicts/u);
    await fs.writeFile(path.join(store.root, `${transactionId}.json`), "{not-json", "utf8");
    await assert.rejects(() => store.read(transactionId));
    assert.equal(guard.blockedAttempts(), 0);
    console.log(JSON.stringify({
      writeOnce: true,
      replayReused: true,
      conflictRejected: true,
      corruptReceiptFailClosed: true,
      externalNetworkCalls: 0
    }));
  } finally {
    guard.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
