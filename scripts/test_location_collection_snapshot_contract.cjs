"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { atomicWriteJson, readJsonFile } = require("./secure_json_store.cjs");
const {
  CollectionSnapshotContractError,
  SNAPSHOT_HISTORY_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  appendCollectionSnapshot,
  assertValidCollectionSnapshotHistory,
  buildCollectionSnapshot,
  computeCollectionContentHash,
  createCollectionSnapshotHistory,
  validateCollectionSnapshot,
  validateCollectionSnapshotHistory
} = require("./location_collection_snapshot_contract.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location collection snapshot contract fixtures" });

function clone(value) {
  return structuredClone(value);
}

function snapshotInput(overrides = {}) {
  const sourceId = overrides.sourceId || "kto.gocamping.inventory";
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: "snapshot-pocheon-2026-08-01-001",
    taskKey: "task:pocheon:2026-08-01:001",
    sourceId,
    regionKey: "kr_gyeonggi_pocheon",
    sharedCollectionScope: "",
    operation: "basedList",
    measurementPeriod: { from: "2026-07-01", to: "2026-07-31" },
    overlapPeriod: null,
    collectedAt: "2026-08-01T00:00:00.000Z",
    asOf: "2026-08-01T01:00:00.000Z",
    providerPublishedAt: "2026-07-31T23:00:00.000Z",
    watermark: { modifiedtime: "20260731230000" },
    requestPlanVersion: "pilot-request-plan.v1",
    mappingVersion: "location-region-registry.v1",
    sourceSchemaVersion: "gocamping.based-list.v1",
    sampleCount: 3,
    coverage: { numerator: 3, denominator: 3, note: "synthetic complete fixture" },
    status: "ready",
    confidence: { grade: "A", score: 96 },
    penalties: [],
    supersedesSnapshotId: "",
    provenance: {
      sourceId,
      provider: "KTO GoCamping",
      datasetId: "15101933",
      requestDescriptorHash: "a".repeat(64),
      fixtureOnly: true,
      networkAccess: false
    },
    ...overrides
  };
}

function expectContractError(run, expectedCode) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof CollectionSnapshotContractError);
    assert.equal(error.code, "LOCATION_COLLECTION_SNAPSHOT_INVALID");
    assert.ok(error.errors.some((entry) => entry.code === expectedCode), `expected ${expectedCode}: ${JSON.stringify(error.errors)}`);
    return true;
  });
}

(async () => {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "location-snapshot-contract-"));
  try {
    const ready = buildCollectionSnapshot(snapshotInput());
    assert.equal(ready.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(ready.status, "ready");
    assert.equal(ready.sampleCount, 3);
    assert.match(ready.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(ready), true);
    assert.equal(Object.isFrozen(ready.provenance), true);
    assert.equal(validateCollectionSnapshot(ready).valid, true);
    assert.equal(computeCollectionContentHash(ready), ready.contentHash);

    const reordered = snapshotInput({
      watermark: { second: { y: 2, x: 1 }, first: true },
      provenance: {
        networkAccess: false,
        fixtureOnly: true,
        requestDescriptorHash: "a".repeat(64),
        datasetId: "15101933",
        provider: "KTO GoCamping",
        sourceId: "kto.gocamping.inventory"
      }
    });
    const sameContentDifferentOrder = snapshotInput({
      watermark: { first: true, second: { x: 1, y: 2 } },
      provenance: {
        sourceId: "kto.gocamping.inventory",
        provider: "KTO GoCamping",
        datasetId: "15101933",
        requestDescriptorHash: "a".repeat(64),
        fixtureOnly: true,
        networkAccess: false
      }
    });
    assert.equal(computeCollectionContentHash(reordered), computeCollectionContentHash(sameContentDifferentOrder), "contentHash must be stable across object key order");

    const zero = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-zero",
      taskKey: "task:pocheon:zero",
      sampleCount: 0,
      coverage: { numerator: 0, denominator: 18, note: "synthetic observed zero" },
      status: "zero",
      confidence: { grade: "A", score: 92 }
    }));
    const missing = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-missing",
      taskKey: "task:pocheon:missing",
      sampleCount: null,
      coverage: { numerator: null, denominator: null, note: "synthetic not observed" },
      status: "missing",
      confidence: { grade: "U", score: null },
      penalties: [{ code: "provider_unavailable", message: "Synthetic fixture", points: null }]
    }));
    const partial = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-partial",
      taskKey: "task:pocheon:partial",
      sampleCount: 3,
      coverage: { numerator: 3, denominator: 5, note: "synthetic partial coverage" },
      status: "partial",
      confidence: { grade: "C", score: 58 },
      penalties: [{ code: "coverage_partial", message: "Synthetic fixture", points: 22 }]
    }));
    assert.equal(zero.status, "zero");
    assert.equal(zero.sampleCount, 0);
    assert.equal(missing.status, "missing");
    assert.equal(missing.sampleCount, null);
    assert.deepEqual(missing.confidence, { grade: "U", score: null });
    assert.equal(partial.status, "partial");
    assert.equal(partial.coverage.ratio, 3 / 5);
    assert.notEqual(zero.status, missing.status, "observed zero must never collapse into missing");

    expectContractError(
      () => buildCollectionSnapshot(snapshotInput({ snapshotId: "bad-missing", taskKey: "bad:missing", status: "missing", sampleCount: 0 })),
      "status_requires_null"
    );
    expectContractError(
      () => buildCollectionSnapshot(snapshotInput({
        snapshotId: "bad-missing-coverage",
        taskKey: "bad:missing:coverage",
        status: "missing",
        sampleCount: null,
        confidence: { grade: "U", score: null }
      })),
      "status_requires_null"
    );
    expectContractError(
      () => buildCollectionSnapshot(snapshotInput({ snapshotId: "bad-zero", taskKey: "bad:zero", status: "zero", sampleCount: 1 })),
      "zero_requires_zero"
    );
    expectContractError(
      () => buildCollectionSnapshot(snapshotInput({ snapshotId: "bad-partial", taskKey: "bad:partial", status: "partial", penalties: [] })),
      "reason_required"
    );
    for (const invalidPeriod of [
      { from: "2026-02-30", to: "2026-02-30" },
      { from: "2026-07-01T00:00:00.000Z", to: "2026-07-31" }
    ]) {
      expectContractError(
        () => buildCollectionSnapshot(snapshotInput({
          snapshotId: `bad-period-${invalidPeriod.from.replace(/[^0-9]/g, "")}`,
          taskKey: `bad:period:${invalidPeriod.from.replace(/[^0-9]/g, "")}`,
          measurementPeriod: invalidPeriod
        })),
        "invalid_date"
      );
    }
    expectContractError(
      () => buildCollectionSnapshot(snapshotInput({
        snapshotId: "bad-overlap-calendar-date",
        taskKey: "bad:overlap:calendar-date",
        overlapPeriod: { from: "2026-02-30", to: "2026-03-01" }
      })),
      "invalid_date"
    );

    const mutated = clone(ready);
    mutated.sampleCount = 4;
    const mutationValidation = validateCollectionSnapshot(mutated);
    assert.equal(mutationValidation.valid, false);
    assert.ok(mutationValidation.errors.some((entry) => entry.code === "hash_mismatch"));

    for (const forbidden of [
      { headers: { Authorization: "must-not-appear" } },
      { query: { serviceKey: "must-not-appear" } },
      { requestHeadersRaw: { value: "must-not-appear" } },
      { provenance: { ...snapshotInput().provenance, clientSecret: "must-not-appear" } },
      { provenance: { ...snapshotInput().provenance, credentialEnvNames: ["MUST_NOT_APPEAR"] } },
      { provenance: { ...snapshotInput().provenance, catalogUrl: "https://example.go.kr/catalog?serviceKey=must-not-appear" } }
    ]) {
      let caught;
      try {
        buildCollectionSnapshot(snapshotInput(forbidden));
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof CollectionSnapshotContractError);
      assert.ok(caught.errors.some((entry) => entry.code === "sensitive_transport_metadata_forbidden"));
      assert.equal(caught.message.includes("must-not-appear"), false, "contract errors must not echo credential-like values");
    }

    const snapshots = Array.from({ length: 105 }, (_, index) => {
      const collectedAt = new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 1000).toISOString();
      return buildCollectionSnapshot(snapshotInput({
        snapshotId: `snapshot-pocheon-history-${String(index + 1).padStart(3, "0")}`,
        taskKey: `task:pocheon:history:${String(index + 1).padStart(3, "0")}`,
        collectedAt,
        asOf: "2026-08-02T00:00:00.000Z",
        providerPublishedAt: "2026-07-31T23:00:00.000Z"
      }));
    });
    const history = createCollectionSnapshotHistory({
      historyId: "history:pocheon:gocamping",
      sourceId: "kto.gocamping.inventory",
      regionKey: "kr_gyeonggi_pocheon",
      createdAt: snapshots[0].collectedAt,
      snapshots
    });
    assert.equal(history.schemaVersion, SNAPSHOT_HISTORY_SCHEMA_VERSION);
    assert.equal(history.snapshots.length, 105, "history must not apply an arbitrary count limit");
    assert.equal(validateCollectionSnapshotHistory(history).valid, true);

    const appendedSnapshot = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-history-106",
      taskKey: "task:pocheon:history:106",
      collectedAt: "2026-08-01T00:01:45.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
      providerPublishedAt: "2026-07-31T23:00:00.000Z",
      supersedesSnapshotId: "snapshot-pocheon-history-105"
    }));
    const appended = appendCollectionSnapshot(history, appendedSnapshot);
    assert.equal(appended.snapshots.length, 106);
    assert.deepEqual(appended.snapshots.slice(0, 105), history.snapshots, "append must preserve the complete immutable prefix");

    const truncated = { ...clone(appended), snapshots: clone(appended.snapshots.slice(1)) };
    const truncatedValidation = validateCollectionSnapshotHistory(truncated, { previousHistory: appended });
    assert.equal(truncatedValidation.valid, false);
    assert.ok(truncatedValidation.errors.some((entry) => entry.code === "history_truncated"));

    const replacedPrefix = clone(appended);
    replacedPrefix.snapshots[0] = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-history-001",
      taskKey: "task:pocheon:history:001",
      collectedAt: "2026-08-01T00:00:00.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
      providerPublishedAt: "2026-07-31T23:00:00.000Z",
      sampleCount: 2,
      coverage: { numerator: 2, denominator: 2, note: "synthetic replacement" }
    }));
    const immutableValidation = validateCollectionSnapshotHistory(replacedPrefix, { previousHistory: appended });
    assert.equal(immutableValidation.valid, false);
    assert.ok(immutableValidation.errors.some((entry) => entry.code === "immutable_entry_changed"));

    expectContractError(
      () => appendCollectionSnapshot(appended, buildCollectionSnapshot(snapshotInput({
        snapshotId: "snapshot-pocheon-history-duplicate-task",
        taskKey: "task:pocheon:history:106",
        collectedAt: "2026-08-01T00:01:46.000Z",
        asOf: "2026-08-02T00:00:00.000Z"
      }))),
      "duplicate_success"
    );

    const retryTaskKey = "task:pocheon:retry:2026-08";
    const failedAttempt = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-retry-missing",
      taskKey: retryTaskKey,
      collectedAt: "2026-08-03T00:00:00.000Z",
      asOf: "2026-08-04T00:00:00.000Z",
      providerPublishedAt: "",
      watermark: null,
      sampleCount: null,
      coverage: { numerator: null, denominator: null, note: "synthetic failed attempt" },
      status: "missing",
      confidence: { grade: "U", score: null },
      penalties: [{ code: "provider_failure", message: "Synthetic fixture", points: null }]
    }));
    let retryHistory = createCollectionSnapshotHistory({
      historyId: "history:pocheon:gocamping:retry",
      sourceId: failedAttempt.sourceId,
      regionKey: failedAttempt.regionKey,
      createdAt: failedAttempt.collectedAt,
      snapshots: [failedAttempt]
    });
    const partialAttempt = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-retry-partial",
      taskKey: retryTaskKey,
      collectedAt: "2026-08-03T01:00:00.000Z",
      asOf: "2026-08-04T00:00:00.000Z",
      providerPublishedAt: "",
      watermark: null,
      sampleCount: 2,
      coverage: { numerator: 2, denominator: 3, note: "synthetic partial retry" },
      status: "partial",
      confidence: { grade: "C", score: 55 },
      penalties: [{ code: "partial_retry", message: "Synthetic fixture", points: 25 }],
      supersedesSnapshotId: failedAttempt.snapshotId
    }));
    retryHistory = appendCollectionSnapshot(retryHistory, partialAttempt);
    const successfulRetry = buildCollectionSnapshot(snapshotInput({
      snapshotId: "snapshot-pocheon-retry-ready",
      taskKey: retryTaskKey,
      collectedAt: "2026-08-03T02:00:00.000Z",
      asOf: "2026-08-04T00:00:00.000Z",
      providerPublishedAt: "2026-08-03T01:30:00.000Z",
      supersedesSnapshotId: partialAttempt.snapshotId
    }));
    retryHistory = appendCollectionSnapshot(retryHistory, successfulRetry);
    assert.equal(retryHistory.snapshots.length, 3, "failed, partial, and successful attempts with one taskKey must all remain immutable");
    assert.deepEqual(retryHistory.snapshots.map((entry) => entry.status), ["missing", "partial", "ready"]);
    expectContractError(
      () => appendCollectionSnapshot(retryHistory, buildCollectionSnapshot(snapshotInput({
        snapshotId: "snapshot-pocheon-retry-second-success",
        taskKey: retryTaskKey,
        collectedAt: "2026-08-03T03:00:00.000Z",
        asOf: "2026-08-04T00:00:00.000Z",
        providerPublishedAt: "2026-08-03T02:30:00.000Z",
        status: "zero",
        sampleCount: 0,
        coverage: { numerator: 0, denominator: 3, note: "synthetic duplicate success" },
        confidence: { grade: "A", score: 90 },
        supersedesSnapshotId: successfulRetry.snapshotId
      }))),
      "duplicate_success"
    );

    const fixturePath = path.join(fixtureRoot, "snapshot-history.json");
    const validator = (value) => {
      assertValidCollectionSnapshotHistory(value);
      return true;
    };
    await atomicWriteJson(fixturePath, appended, { validator });
    const reloaded = await readJsonFile(fixturePath, { validator });
    assert.equal(reloaded.snapshots.length, 106);
    assert.equal(reloaded.snapshots.at(-1).contentHash, appended.snapshots.at(-1).contentHash);

    const corrupt = clone(reloaded);
    corrupt.snapshots[12].contentHash = "0".repeat(64);
    await atomicWriteJson(fixturePath, corrupt);
    await assert.rejects(
      () => readJsonFile(fixturePath, { validator }),
      (error) => error instanceof CollectionSnapshotContractError && error.errors.some((entry) => entry.code === "hash_mismatch")
    );
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
    assert.equal(networkGuard.blockedAttempts(), 0, "snapshot fixtures must never call the network");
    networkGuard.restore();
  }

  console.log("Location collection snapshot contract fixture checks passed");
})().catch((error) => {
  networkGuard.restore();
  console.error(error);
  process.exitCode = 1;
});
