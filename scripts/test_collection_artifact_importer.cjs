"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createCollectionArtifactImporter,
  decideCollectionArtifactImport
} = require("./collection_artifact_importer.cjs");

const ARTIFACT_A = "a".repeat(64);
const ARTIFACT_B = "b".repeat(64);
const CONTRACT = "c".repeat(64);
const EXECUTION = "d".repeat(64);

function verification(overrides = {}) {
  return {
    verified: true,
    artifactHash: ARTIFACT_A,
    jobId: "job-synthetic-0001",
    attemptId: "attempt:fixture-0001",
    workerId: "worker-a",
    workerPoolId: "v2-runtime-worker",
    contractHash: CONTRACT,
    executionIdentityHash: EXECUTION,
    resultStatus: "ready",
    providerAttemptCount: 0,
    ...overrides
  };
}

async function main() {
  let verifyCalls = 0;
  const noStore = decideCollectionArtifactImport({
    signedArtifact: { schemaVersion: 1 },
    files: {},
    verifier() {
      verifyCalls += 1;
      return verification({ resultStatus: "partial" });
    },
    saveResult: false,
    previewWriteApproved: false
  });
  assert.equal(verifyCalls, 1);
  assert.equal(noStore.decision, "validated_no_store");
  assert.equal(noStore.saveResult, false);

  assert.throws(
    () => decideCollectionArtifactImport({
      signedArtifact: {},
      verifier: () => verification({ providerAttemptCount: 2 }),
      saveResult: false,
      previewWriteApproved: false
    }),
    { code: "COLLECTION_ARTIFACT_IMPORT_INVALID", statusCode: 400 }
  );
  assert.throws(
    () => decideCollectionArtifactImport({
      signedArtifact: {},
      verifier: () => verification({ workerId: "worker/unsafe" }),
      saveResult: false,
      previewWriteApproved: false
    }),
    { code: "COLLECTION_ARTIFACT_IMPORT_INVALID", statusCode: 400 }
  );

  assert.throws(
    () => decideCollectionArtifactImport({
      signedArtifact: { outputDir: "/var/data/worker-output" },
      verifier: () => verification(),
      saveResult: false
    }),
    { code: "COLLECTION_ARTIFACT_REMOTE_IDENTITY_FORBIDDEN", statusCode: 400 }
  );
  assert.throws(
    () => decideCollectionArtifactImport({
      signedArtifact: {},
      verifier: () => verification({ resultStatus: "blocked" }),
      saveResult: true,
      previewWriteApproved: true
    }),
    { code: "COLLECTION_ARTIFACT_NOT_READY", statusCode: 409 }
  );

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-artifact-import-"));
  try {
    const importer = createCollectionArtifactImporter({ runtimeRoot: tempRoot });
    await assert.rejects(
      () => importer.prepareVerifiedImport({ verification: verification(), saveResult: false, previewWriteApproved: false }),
      { code: "COLLECTION_ARTIFACT_WRITE_NOT_APPROVED", statusCode: 403 }
    );
    await assert.rejects(() => fsp.stat(importer.ledgerPath), { code: "ENOENT" });

    const prepared = await importer.prepareVerifiedImport({
      verification: verification(),
      saveResult: true,
      previewWriteApproved: true,
      now: "2026-08-06T02:00:00.000Z"
    });
    assert.match(prepared.previewRunId, /^preview-run-[a-f0-9]{20}$/u);
    assert.equal(prepared.stagingRelativePath.startsWith("imports/pending/"), true);
    assert.equal(prepared.finalRelativePath, `outputs/${prepared.previewRunId}`);
    assert.equal(JSON.stringify(prepared).includes("/var/data"), false);

    const reused = await importer.prepareVerifiedImport({
      verification: verification(),
      saveResult: true,
      previewWriteApproved: true,
      now: "2026-08-06T02:00:01.000Z"
    });
    assert.equal(reused.importId, prepared.importId);
    assert.equal(reused.reused, true);
    assert.equal((await importer.readLedger()).imports.length, 1);

    await assert.rejects(
      () => importer.prepareVerifiedImport({
        verification: verification({ artifactHash: ARTIFACT_B }),
        saveResult: true,
        previewWriteApproved: true
      }),
      { code: "COLLECTION_ARTIFACT_JOB_CONFLICT", statusCode: 409 }
    );

    const validated = await importer.transitionImport({
      importId: prepared.importId,
      expectedWorkflowRevision: prepared.workflowRevision,
      nextState: "validated",
      now: "2026-08-06T02:00:02.000Z"
    });
    const effected = await importer.transitionImport({
      importId: prepared.importId,
      expectedWorkflowRevision: validated.workflowRevision,
      nextState: "effects_applied",
      now: "2026-08-06T02:00:03.000Z"
    });
    const committed = await importer.transitionImport({
      importId: prepared.importId,
      expectedWorkflowRevision: effected.workflowRevision,
      nextState: "committed",
      now: "2026-08-06T02:00:04.000Z"
    });
    assert.equal(committed.state, "committed");

    await assert.rejects(
      () => importer.transitionImport({
        importId: prepared.importId,
        expectedWorkflowRevision: committed.workflowRevision - 1,
        nextState: "committed"
      }),
      { code: "COLLECTION_ARTIFACT_IMPORT_REVISION_CONFLICT", statusCode: 409 }
    );

    console.log("Collection worker Preview-owned artifact import fixture checks passed");
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected fixture directory: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
