"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildCollectionArtifactBundle,
  sha256Hex,
  verifyCollectionArtifactBundle,
} = require("./collection_artifact_contract.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCOPE,
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_ARTIFACT_SCHEMA_VERSION,
  V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
  computeV2Top20ProviderCallTraceHash,
  expectedV2Top20ProviderCallTrace,
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  COLLECTION_WORKER_TOP20_RESULT_PATH,
  COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION,
  createCollectionWorkerRunTransactionStore,
  isCommittedRunOutputValid,
} = require("./collection_worker_run_transaction.cjs");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const signingKeyId = "fixture-worker-key-v1";
const identity = Object.freeze({
  jobId: "job-transaction-fixture-0001",
  attemptId: "attempt-transaction-0001",
  workerId: "worker-fixture-01",
  workerPoolId: "pool-fixture-v1",
  runtimeId: "runtime-fixture-node",
  contractHash: "a".repeat(64),
  executionIdentityHash: "b".repeat(64),
});
const fixtureNow = "2026-08-06T08:00:00.000Z";
const observedAt = "2026-08-06T07:59:00.000Z";

let unexpectedNetworkCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  unexpectedNetworkCalls += 1;
  throw new Error("fixture network is disabled");
};

function makePayload(options = {}) {
  const count = options.count ?? 20;
  const zeroAt = options.zeroAt ?? null;
  const itemStatusAt = options.itemStatusAt ?? null;
  const itemStatus = options.itemStatus || "missing";
  const results = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const status = ordinal === itemStatusAt ? itemStatus : ordinal === zeroAt ? "zero" : "ready";
    const ready = status === "ready";
    return {
      ordinal,
      rank: ordinal,
      status,
      company: {
        companyKey: `fixture-company-${String(ordinal).padStart(2, "0")}`,
        displayName: `Fixture Company ${ordinal}`,
        regionKey: "kr_gyeongnam_fixture",
      },
      products: ready
        ? [
          {
            productKey: `fixture-product-${String(ordinal).padStart(2, "0")}`,
            displayName: `Fixture Room ${ordinal}`,
            stayType: "overnight",
            price: 100000 + ordinal,
            availableUnits: ordinal % 4,
            status: "ready",
          },
        ]
        : [],
      revenue: {
        status,
        estimatedRevenue: ready ? 500000 + ordinal : 0,
        estimatedSoldUnits: ready ? ordinal : 0,
        currency: "KRW",
      },
      provenance: {
        source: "naver_place_public_inventory",
        observedAt,
      },
    };
  });
  if (options.outOfOrder === true) results[9].rank = 11;
  if (options.duplicateCompany === true) results[19].company.companyKey = results[0].company.companyKey;
  if (options.changedRevenue === true) results[0].revenue.estimatedRevenue += 1;
  return {
    schemaVersion: COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION,
    status: options.topStatus || "ready",
    resultCount: count,
    measurementPeriod: { start: "2026-08-06", end: "2026-08-06" },
    collectedAt: fixtureNow,
    results,
  };
}

function signPayload(payload, overrides = {}) {
  return buildCollectionArtifactBundle(
    {
      identity: overrides.identity || identity,
      files: [
        {
          path: COLLECTION_WORKER_TOP20_RESULT_PATH,
          content: JSON.stringify(payload),
        },
      ],
    },
    { privateKey, keyId: signingKeyId },
  );
}

function fixtureCsv(rows) {
  const headers = Object.keys(rows[0] || {});
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(",")),
  ].join("\n")}\n`;
}

function makeV2RunArtifact(options = {}) {
  const detailPaths = options.includeDetail === false ? [] : ["details/detail-01.json"];
  const fileRoles = Object.fromEntries(
    ["platform", "overall", "ads", "regional", "ddnayo"].map((role) => [role, `${role}.csv`]),
  );
  const zeroAt = Number(options.zeroAt || 0);
  const inventoryTargetResults = Array.from({ length: 20 }, (_, index) => {
    const status = index + 1 === zeroAt ? "zero" : "ready";
    return {
      companyOrdinal: index + 1,
      placeId: String(100000 + index + 1),
      status,
      revenueInputValid: true,
      bookingBusiness: 1,
      bookingItems: status === "zero" ? 0 : 1,
      dailySchedule: status === "zero" ? 0 : 1,
    };
  });
  const providerCallTrace = expectedV2Top20ProviderCallTrace(inventoryTargetResults);
  const readyCount = inventoryTargetResults.filter((target) => target.status === "ready").length;
  const zeroCount = inventoryTargetResults.length - readyCount;
  const overallRows = Array.from({ length: 50 }, (_, index) => {
    const rank = index + 1;
    const target = inventoryTargetResults[index] || null;
    const ready = target?.status === "ready";
    return {
      overall_rank: rank,
      place_id: String(100000 + rank),
      "업체명": `Synthetic Company ${rank}`,
      "주소": `Synthetic Region ${rank}`,
      "숙박상품수": ready ? 1 : 0,
      "데이유즈상품수": 0,
      "숙박예약가능수": ready ? rank % 4 : 0,
      "데이유즈예약가능수": 0,
      "숙박기준일평균판매단가": ready ? 100000 + rank : 0,
      "예약최저가": ready ? `${(100000 + rank).toLocaleString("en-US")}원` : "",
      "데이유즈기준일평균판매단가": 0,
      "숙박기준일예상매출": ready ? 500000 + rank : 0,
      "데이유즈기준일예상매출": 0,
      "숙박기준일가격확인판매수량": ready ? rank : 0,
      "데이유즈기준일가격확인판매수량": 0,
      fixture_marker: options.csvSuffix || "",
    };
  });
  const manifest = {
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    collectorVersion: "fixture-v2-top20",
    collectionStartedAt: observedAt,
    collectionCompletedAt: fixtureNow,
    dataAvailableAt: fixtureNow,
    keyword: "Synthetic regional lodging",
    searchMode: "keyword",
    searchRegionKey: "kr_gyeongnam_fixture",
    provinceKey: "gyeongnam",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    collectorActivationProfile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    collectionPurpose: "revenue_detail",
    collectionMode: "precision",
    productMode: "all",
    detailRankRanges: "1-20",
    bookingRangeDays: 1,
    automaticRetry: false,
    automaticFallback: false,
    saveRunOnSuccessOnly: true,
    saveFailureRun: false,
    revenueEstimateBasis: V2_TOP20_CONTRACT.revenueEstimateBasis,
    counts: {
      naverOverall: 50,
      naverBookingStockChecked: 20,
    },
    inventoryResultCounts: {
      planned: 20,
      ready: readyCount,
      zero: zeroCount,
      missing: 0,
      partial: 0,
    },
    providerCallCounts: {
      total: providerCallTrace.length,
      mainPlace: 1,
      inventory: {
        bookingBusiness: 20,
        bookingItems: readyCount,
        dailySchedule: readyCount,
        total: providerCallTrace.length - 1,
      },
    },
    providerCallTraceSchemaVersion: V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
    providerCallTrace,
    providerCallTraceHash: computeV2Top20ProviderCallTraceHash(providerCallTrace),
    providerMaxObservedConcurrency: 1,
    inventoryTargetResults,
    fileRoles,
    files: [...Object.values(fileRoles), ...detailPaths],
    detailJsonFiles: detailPaths,
  };
  const runFiles = [
    {
      path: "run/manifest.json",
      content: JSON.stringify(manifest, null, 2),
    },
    ...Object.keys(fileRoles).map((role) => ({
      path: `run/${role}.csv`,
      content: role === "overall"
        ? fixtureCsv(overallRows)
        : `rank,place_id,value\n1,100001,fixture-${role}${options.csvSuffix || ""}\n`,
    })),
    ...detailPaths.map((detailPath) => ({
      path: `run/${detailPath}`,
      content: JSON.stringify({ companyOrdinal: 1, status: "ready", products: 1 }),
    })),
  ];
  const contentHashes = Object.fromEntries(runFiles.map((file) => [file.path, sha256Hex(file.content)]));
  const summary = {
    schemaVersion: V2_TOP20_ARTIFACT_SCHEMA_VERSION,
    status: "ready",
    profile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    contractHash: identity.contractHash,
    executionIdentityHash: identity.executionIdentityHash,
    providerAttemptCount: 1,
    executedCallCount: providerCallTrace.length,
    automaticRetry: false,
    automaticFallback: false,
    resultStored: false,
    writeCount: 0,
    organicCount: 50,
    inventoryTargetCount: 20,
    readyCount,
    zeroCount,
    targetResults: manifest.inventoryTargetResults,
    providerCallTraceHash: manifest.providerCallTraceHash,
    contentHashes,
  };
  return buildCollectionArtifactBundle(
    {
      identity,
      files: [
        { path: "top20-summary.json", content: JSON.stringify(summary) },
        ...runFiles,
      ],
    },
    { privateKey, keyId: signingKeyId },
  );
}

function verifiedV2Artifact(signedArtifact) {
  return verifyCollectionArtifactBundle(signedArtifact, {
    publicKey,
    expectedIdentity: identity,
    expectedSigningKeyId: signingKeyId,
  });
}

function mutateVerifiedFile(verifiedArtifact, filePath, mutate) {
  const next = JSON.parse(JSON.stringify(verifiedArtifact));
  const file = next.bundle.files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `missing fixture file ${filePath}`);
  const original = Buffer.from(file.contentBase64, "base64").toString("utf8");
  const content = String(mutate(original));
  file.contentBase64 = Buffer.from(content).toString("base64");
  file.size = Buffer.byteLength(content);
  file.sha256 = sha256Hex(content);
  return next;
}

function synchronizeFakeSummaryHash(verifiedArtifact, artifactPath) {
  const target = verifiedArtifact.bundle.files.find((candidate) => candidate.path === artifactPath);
  return mutateVerifiedFile(verifiedArtifact, "top20-summary.json", (text) => {
    const summary = JSON.parse(text);
    summary.contentHashes[artifactPath] = target.sha256;
    return JSON.stringify(summary);
  });
}

function verifierFor(expectedIdentity = identity) {
  return (signedArtifact) => verifyCollectionArtifactBundle(signedArtifact, {
    publicKey,
    expectedIdentity,
    expectedSigningKeyId: signingKeyId,
  });
}

async function temporaryRuntime(label, callback) {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `collection-run-tx-${label}-`));
  try {
    return await callback(runtimeRoot);
  } finally {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function assertVisibleCounts(visible, expected = {}) {
  assert.equal(visible.runs.length, expected.runs ?? 1);
  assert.equal(visible.companies.length, expected.companies ?? 20);
  assert.equal(visible.products.length, expected.products ?? 20);
  assert.equal(visible.revenues.length, expected.revenues ?? 20);
  assert.equal(visible.history.length, expected.history ?? 20);
}

async function listAllRelativeFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(path.relative(root, target).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files.sort();
}

function oneShotFault(point) {
  let fired = false;
  return async (actualPoint) => {
    if (!fired && actualPoint === point) {
      fired = true;
      const error = new Error(`fixture fault: ${point}`);
      error.code = "FIXTURE_TRANSACTION_FAULT";
      throw error;
    }
  };
}

async function testReadyCommitAndReplay() {
  await temporaryRuntime("ready", async (runtimeRoot) => {
    const signedArtifact = signPayload(makePayload());
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    assertVisibleCounts(await store.readVisibleState(), {
      runs: 0,
      companies: 0,
      products: 0,
      revenues: 0,
      history: 0,
    });
    const committed = await store.finalizeVerifiedArtifact({
      signedArtifact,
      verifier: verifierFor(),
    });
    assert.equal(committed.state, "committed");
    assert.equal(committed.reused, false);
    assert.equal(committed.resultCount, 20);
    assertVisibleCounts(await store.readVisibleState());

    const beforeReplay = await store.readVisibleState();
    const replayed = await store.finalizeVerifiedArtifact({
      signedArtifact,
      verifier: verifierFor(),
    });
    assert.equal(replayed.state, "committed");
    assert.equal(replayed.reused, true);
    assert.deepEqual(await store.readVisibleState(), beforeReplay);
    const journal = await store.readJournal();
    assert.equal(journal.staged.length, 1);
    assert.equal(journal.committed.length, 1);
    const files = await listAllRelativeFiles(runtimeRoot);
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => file.startsWith("collector_worker/run_transactions/")));
    assert.ok(files.every((file) => !path.basename(file).startsWith(".")));
  });
}

async function testProviderConfirmedZero() {
  await temporaryRuntime("zero", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    await store.finalizeVerifiedArtifact({
      signedArtifact: signPayload(makePayload({ zeroAt: 20 })),
      verifier: verifierFor(),
    });
    const visible = await store.readVisibleState();
    assertVisibleCounts(visible, { products: 19 });
    assert.equal(visible.runs[0].readyCount, 19);
    assert.equal(visible.runs[0].zeroCount, 1);
    const zeroRevenue = visible.revenues.find((entry) => entry.status === "zero");
    assert.ok(zeroRevenue);
    assert.equal(zeroRevenue.estimatedRevenue, 0);
    assert.equal(zeroRevenue.estimatedSoldUnits, 0);
    assert.equal(visible.history.filter((entry) => entry.status === "zero").length, 1);
  });
}

async function testRejectedArtifactsHaveNoVisibleEffects() {
  await temporaryRuntime("reject", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    for (const status of ["missing", "partial", "blocked", "failed", "conflict"]) {
      await expectCode(
        store.finalizeVerifiedArtifact({
          signedArtifact: signPayload(makePayload({ itemStatusAt: 7, itemStatus: status })),
          verifier: verifierFor(),
        }),
        "COLLECTION_RUN_ARTIFACT_NOT_READY",
      );
    }
    await expectCode(
      store.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload({ topStatus: "partial" })),
        verifier: verifierFor(),
      }),
      "COLLECTION_RUN_ARTIFACT_NOT_READY",
    );
    await expectCode(
      store.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload({ count: 19 })),
        verifier: verifierFor(),
      }),
      "COLLECTION_RUN_ARTIFACT_INCOMPLETE",
    );
    await expectCode(
      store.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload({ outOfOrder: true })),
        verifier: verifierFor(),
      }),
      "COLLECTION_RUN_ARTIFACT_ORDER_INVALID",
    );
    await expectCode(
      store.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload({ duplicateCompany: true })),
        verifier: verifierFor(),
      }),
      "COLLECTION_RUN_ARTIFACT_DUPLICATE",
    );

    const tampered = JSON.parse(JSON.stringify(signPayload(makePayload())));
    tampered.bundle.files[0].contentBase64 = Buffer.from(JSON.stringify(makePayload({ changedRevenue: true })))
      .toString("base64");
    await expectCode(
      store.finalizeVerifiedArtifact({ signedArtifact: tampered, verifier: verifierFor() }),
      "COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED",
    );
    assertVisibleCounts(await store.readVisibleState(), {
      runs: 0,
      companies: 0,
      products: 0,
      revenues: 0,
      history: 0,
    });
    const journal = await store.readJournal();
    assert.equal(journal.staged.length, 0);
    assert.equal(journal.committed.length, 0);
  });
}

async function testFaultsBeforeCommitRemainInvisibleAndRecover() {
  for (const point of ["before_stage_write", "after_stage_write_before_response", "before_commit_marker"]) {
    await temporaryRuntime(point, async (runtimeRoot) => {
      const signedArtifact = signPayload(makePayload());
      const faultedStore = createCollectionWorkerRunTransactionStore({
        runtimeRoot,
        now: () => fixtureNow,
        faultInjector: oneShotFault(point),
      });
      await expectCode(
        faultedStore.finalizeVerifiedArtifact({ signedArtifact, verifier: verifierFor() }),
        "FIXTURE_TRANSACTION_FAULT",
      );
      assertVisibleCounts(await faultedStore.readVisibleState(), {
        runs: 0,
        companies: 0,
        products: 0,
        revenues: 0,
        history: 0,
      });

      const restartedStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
      const recovered = await restartedStore.finalizeVerifiedArtifact({ signedArtifact, verifier: verifierFor() });
      assert.equal(recovered.state, "committed");
      assertVisibleCounts(await restartedStore.readVisibleState());
      assert.equal((await restartedStore.readJournal()).committed.length, 1);
    });
  }
}

async function testResponseLossAfterCommitIsExactlyOnce() {
  await temporaryRuntime("response-loss", async (runtimeRoot) => {
    const signedArtifact = signPayload(makePayload());
    const faultedStore = createCollectionWorkerRunTransactionStore({
      runtimeRoot,
      now: () => fixtureNow,
      faultInjector: oneShotFault("after_commit_marker_before_response"),
    });
    await expectCode(
      faultedStore.finalizeVerifiedArtifact({ signedArtifact, verifier: verifierFor() }),
      "FIXTURE_TRANSACTION_FAULT",
    );
    assertVisibleCounts(await faultedStore.readVisibleState());
    const beforeReplay = await faultedStore.readVisibleState();

    const restartedStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const recovered = await restartedStore.finalizeVerifiedArtifact({ signedArtifact, verifier: verifierFor() });
    assert.equal(recovered.reused, true);
    assert.deepEqual(await restartedStore.readVisibleState(), beforeReplay);
    assert.equal((await restartedStore.readJournal()).committed.length, 1);
  });
}

async function testRevisionCasAndConcurrentFinalizers() {
  await temporaryRuntime("revision", async (runtimeRoot) => {
    const signedArtifact = signPayload(makePayload());
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const staged = await store.stageVerifiedArtifact({ signedArtifact, verifier: verifierFor() });
    await expectCode(
      store.commitStagedTransaction({
        transactionId: staged.transactionId,
        artifactHash: staged.artifactHash,
        expectedTransactionRevision: 2,
        now: fixtureNow,
      }),
      "COLLECTION_RUN_TRANSACTION_REVISION_CONFLICT",
    );
    assert.equal((await store.readVisibleState()).runs.length, 0);
    await store.commitStagedTransaction({
      transactionId: staged.transactionId,
      artifactHash: staged.artifactHash,
      expectedTransactionRevision: staged.transactionRevision,
      now: fixtureNow,
    });
    assertVisibleCounts(await store.readVisibleState());
  });

  await temporaryRuntime("concurrent", async (runtimeRoot) => {
    const signedArtifact = signPayload(makePayload());
    const firstStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const secondStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const receipts = await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 ? firstStore : secondStore).finalizeVerifiedArtifact({
        signedArtifact,
        verifier: verifierFor(),
      })),
    );
    assert.equal(receipts.filter((entry) => entry.reused === false).length, 1);
    assert.equal(new Set(receipts.map((entry) => entry.runId)).size, 1);
    assertVisibleCounts(await firstStore.readVisibleState());
    assert.equal((await firstStore.readJournal()).committed.length, 1);

    await expectCode(
      firstStore.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload({ changedRevenue: true })),
        verifier: verifierFor(),
      }),
      "COLLECTION_RUN_TRANSACTION_CONFLICT",
    );
    const conflictingIdentity = {
      ...identity,
      attemptId: "attempt-transaction-0002",
      executionIdentityHash: "c".repeat(64),
    };
    await expectCode(
      firstStore.finalizeVerifiedArtifact({
        signedArtifact: signPayload(makePayload(), { identity: conflictingIdentity }),
        verifier: verifierFor(conflictingIdentity),
      }),
      "COLLECTION_RUN_TRANSACTION_CONFLICT",
    );
    assertVisibleCounts(await firstStore.readVisibleState());
    assert.equal((await firstStore.readJournal()).committed.length, 1);
  });
}

async function testCommittedMarkerTamperFailsClosed() {
  await temporaryRuntime("marker-tamper", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedArtifact({
      signedArtifact: signPayload(makePayload()),
      verifier: verifierFor(),
    });
    const markerPath = path.join(store.committedRoot, `${committed.transactionId}.json`);
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
    marker.projections.revenues[0].estimatedRevenue += 1;
    await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
    await assert.rejects(store.readVisibleState(), /failed validation/u);
  });
}

async function testV2RunBundleAtomicPublishAndReplay() {
  await temporaryRuntime("run-bundle", async (runtimeRoot) => {
    const signedArtifact = makeV2RunArtifact();
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedRunBundle({
      signedArtifact,
      verifier: verifiedV2Artifact,
    });
    assert.equal(committed.state, "committed");
    assert.equal(committed.reused, false);
    assert.equal(committed.outputValid, true);
    assert.equal(committed.fileCount, 7);
    assert.equal(committed.companyProjectionCount, 20);
    assert.equal(committed.productProjectionCount, 20);
    assert.equal(committed.revenueProjectionCount, 20);
    assert.equal(committed.historyProjectionCount, 20);
    const visible = await store.readVisibleState();
    assertVisibleCounts(visible);
    assert.equal(visible.runs[0].runId, committed.runId);
    assert.equal(new Set(visible.companies.map((company) => company.runId)).size, 1);
    assert.equal(visible.companies[0].runId, committed.runId);
    assert.equal(
      await store.isCommittedRunOutputValid({
        transactionId: committed.transactionId,
        runId: committed.runId,
      }),
      true,
    );
    assert.equal(
      await isCommittedRunOutputValid({
        runtimeRoot,
        transactionId: committed.transactionId,
        runId: committed.runId,
      }),
      true,
    );
    const finalRoot = path.join(runtimeRoot, committed.finalRelativePath);
    const manifest = JSON.parse(await fsp.readFile(path.join(finalRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.runId, committed.runId);
    assert.equal(manifest.outputDir, committed.finalRelativePath);
    assert.equal(manifest.transactionId, committed.transactionId);
    assert.equal(manifest.previewOwnedStorageIdentity, true);
    assert.equal(manifest.workerArtifactHash, committed.artifactHash);
    assert.equal(await fsp.readFile(path.join(finalRoot, "platform.csv"), "utf8").then(Boolean), true);
    assert.equal(await fsp.readFile(path.join(finalRoot, "details", "detail-01.json"), "utf8").then(Boolean), true);

    const beforeReplay = await listAllRelativeFiles(runtimeRoot);
    const replayed = await store.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact });
    assert.equal(replayed.reused, true);
    assert.equal(replayed.runId, committed.runId);
    assert.deepEqual(await listAllRelativeFiles(runtimeRoot), beforeReplay);
    assertVisibleCounts(await store.readVisibleState());
    const journal = await store.readRunOutputJournal();
    assert.equal(journal.staged.length, 1);
    assert.equal(journal.committed.length, 1);
  });

  await temporaryRuntime("run-bundle-no-details", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedRunBundle({
      signedArtifact: makeV2RunArtifact({ includeDetail: false }),
      verifier: verifiedV2Artifact,
    });
    assert.equal(committed.fileCount, 6);
    assert.equal(await store.isCommittedRunOutputValid({ runId: committed.runId }), true);
    assertVisibleCounts(await store.readVisibleState());
    const detailsKind = await fsp.lstat(path.join(runtimeRoot, committed.finalRelativePath, "details")).then(
      () => "present",
      (error) => error?.code === "ENOENT" ? "missing" : Promise.reject(error),
    );
    assert.equal(detailsKind, "missing");
  });

  await temporaryRuntime("run-bundle-zero", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedRunBundle({
      signedArtifact: makeV2RunArtifact({ zeroAt: 7, includeDetail: false }),
      verifier: verifiedV2Artifact,
    });
    const visible = await store.readVisibleState();
    assertVisibleCounts(visible, { products: 19 });
    assert.equal(committed.productProjectionCount, 19);
    assert.equal(visible.runs[0].readyCount, 19);
    assert.equal(visible.runs[0].zeroCount, 1);
    assert.equal(visible.companies[6].status, "zero");
    assert.equal(visible.revenues[6].estimatedRevenue, 0);
    assert.equal(visible.history[6].status, "zero");
    assert.equal(visible.products.some((product) => product.companyKey === visible.companies[6].companyKey), false);
  });
}

async function testV2RunBundleConcurrentFinalizers() {
  await temporaryRuntime("run-concurrent", async (runtimeRoot) => {
    const signedArtifact = makeV2RunArtifact();
    const firstStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const secondStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const receipts = await Promise.all(Array.from({ length: 10 }, (_, index) => (
      index % 2 ? firstStore : secondStore
    ).finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact })));
    assert.equal(receipts.filter((receipt) => receipt.reused === false).length, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.runId)).size, 1);
    assert.equal((await firstStore.readRunOutputJournal()).committed.length, 1);
    assert.equal((await fsp.readdir(path.join(runtimeRoot, "outputs"))).length, 1);
    assert.equal(await firstStore.isCommittedRunOutputValid({ runId: receipts[0].runId }), true);
    assertVisibleCounts(await firstStore.readVisibleState());
  });
}

async function testV2RunBundleFaultRecovery() {
  const points = [
    "before_run_stage_write",
    "after_run_stage_files_before_rename",
    "after_run_stage_rename_before_journal",
    "after_run_stage_journal_before_response",
    "before_run_output_rename",
    "after_run_output_rename_before_marker",
    "after_run_commit_marker_before_response",
  ];
  for (const point of points) {
    await temporaryRuntime(`run-${point}`, async (runtimeRoot) => {
      const signedArtifact = makeV2RunArtifact();
      const faultedStore = createCollectionWorkerRunTransactionStore({
        runtimeRoot,
        now: () => fixtureNow,
        faultInjector: oneShotFault(point),
      });
      await expectCode(
        faultedStore.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact }),
        "FIXTURE_TRANSACTION_FAULT",
      );
      const preRecoveryJournal = await faultedStore.readRunOutputJournal();
      const markerExists = preRecoveryJournal.committed.length === 1;
      const visibleBeforeRecovery = await faultedStore.readVisibleState();
      assertVisibleCounts(visibleBeforeRecovery, markerExists ? {} : {
        runs: 0,
        companies: 0,
        products: 0,
        revenues: 0,
        history: 0,
      });
      const finalDirectories = await fsp.readdir(path.join(runtimeRoot, "outputs"), { withFileTypes: true })
        .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
      const finalRun = finalDirectories.find((entry) => entry.isDirectory());
      if (point === "after_run_output_rename_before_marker") {
        assert.ok(finalRun, "rename-before-marker fault must leave a recoverable final tree");
        assert.equal(markerExists, false);
        assert.equal(await faultedStore.isCommittedRunOutputValid({ runId: finalRun.name }), false);
      }
      if (point === "after_run_commit_marker_before_response") {
        assert.ok(finalRun);
        assert.equal(markerExists, true);
        assert.equal(await faultedStore.isCommittedRunOutputValid({ runId: finalRun.name }), true);
      }

      const restartedStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
      const recovered = await restartedStore.finalizeVerifiedRunBundle({
        signedArtifact,
        verifier: verifiedV2Artifact,
      });
      assert.equal(recovered.state, "committed");
      assert.equal(await restartedStore.isCommittedRunOutputValid({
        transactionId: recovered.transactionId,
        runId: recovered.runId,
      }), true);
      const journal = await restartedStore.readRunOutputJournal();
      assert.equal(journal.staged.length, 1);
      assert.equal(journal.committed.length, 1);
      assert.equal((await fsp.readdir(path.join(runtimeRoot, "outputs"))).length, 1);
      assertVisibleCounts(await restartedStore.readVisibleState());
      const runtimeFiles = await listAllRelativeFiles(runtimeRoot);
      assert.equal(runtimeFiles.some((file) => file.includes(".tmp")), false);
    });
  }
}

async function testV2RunBundleRejectsConflictsAndUnsafeArtifacts() {
  await temporaryRuntime("run-conflict", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const first = makeV2RunArtifact();
    await store.finalizeVerifiedRunBundle({ signedArtifact: first, verifier: verifiedV2Artifact });
    await expectCode(
      store.finalizeVerifiedRunBundle({
        signedArtifact: makeV2RunArtifact({ csvSuffix: "-changed" }),
        verifier: verifiedV2Artifact,
      }),
      "COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT",
    );
    assert.equal((await store.readRunOutputJournal()).committed.length, 1);
    assert.equal((await fsp.readdir(path.join(runtimeRoot, "outputs"))).length, 1);
  });

  await temporaryRuntime("run-unsafe", async (runtimeRoot) => {
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const signed = makeV2RunArtifact();
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.bundle.files.find((file) => file.path === "run/platform.csv").contentBase64 = Buffer
      .from("tampered")
      .toString("base64");
    await expectCode(
      store.finalizeVerifiedRunBundle({ signedArtifact: tampered, verifier: verifiedV2Artifact }),
      "COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED",
    );

    const verified = verifiedV2Artifact(signed);
    const traversal = JSON.parse(JSON.stringify(verified));
    traversal.bundle.files.push({
      path: "run/../escape.csv",
      contentBase64: Buffer.from("fixture").toString("base64"),
      size: 7,
      sha256: sha256Hex("fixture"),
    });
    await expectCode(
      store.finalizeVerifiedRunBundle({ signedArtifact: traversal, verifier: (value) => value }),
      "COLLECTION_RUN_OUTPUT_PATH_INVALID",
    );

    let unsafeUrl = mutateVerifiedFile(verified, "run/platform.csv", () => (
      "rank,url\n1,https://provider.invalid/private\n"
    ));
    unsafeUrl = synchronizeFakeSummaryHash(unsafeUrl, "run/platform.csv");
    await expectCode(
      store.finalizeVerifiedRunBundle({ signedArtifact: unsafeUrl, verifier: (value) => value }),
      "COLLECTION_RUN_OUTPUT_SENSITIVE_CONTENT",
    );

    let unsafeHtml = mutateVerifiedFile(verified, "run/overall.csv", () => (
      "<!doctype html><html><body>challenge</body></html>"
    ));
    unsafeHtml = synchronizeFakeSummaryHash(unsafeHtml, "run/overall.csv");
    await expectCode(
      store.finalizeVerifiedRunBundle({ signedArtifact: unsafeHtml, verifier: (value) => value }),
      "COLLECTION_RUN_OUTPUT_SENSITIVE_CONTENT",
    );

    let remoteIdentity = mutateVerifiedFile(verified, "run/manifest.json", (text) => {
      const manifest = JSON.parse(text);
      manifest.runId = "worker-controlled-run";
      manifest.outputDir = "worker-controlled-output";
      manifest.transactionId = "worker-controlled-transaction";
      return JSON.stringify(manifest);
    });
    remoteIdentity = synchronizeFakeSummaryHash(remoteIdentity, "run/manifest.json");
    await expectCode(
      store.finalizeVerifiedRunBundle({ signedArtifact: remoteIdentity, verifier: (value) => value }),
      "COLLECTION_RUN_OUTPUT_REMOTE_IDENTITY_FORBIDDEN",
    );
    assert.equal((await store.readRunOutputJournal()).staged.length, 0);
    assert.equal((await store.readRunOutputJournal()).committed.length, 0);
    assert.equal(await fsp.readdir(path.join(runtimeRoot, "outputs")).catch((error) => (
      error?.code === "ENOENT" ? [] : Promise.reject(error)
    )).then((entries) => entries.length), 0);
    assert.equal(await fsp.readFile(path.join(runtimeRoot, "escape.csv"), "utf8").then(
      () => true,
      (error) => error?.code !== "ENOENT",
    ), false);
  });
}

async function testV2RunBundleTamperAfterRenameFailsClosed() {
  await temporaryRuntime("run-final-tamper", async (runtimeRoot) => {
    const signedArtifact = makeV2RunArtifact();
    const faultedStore = createCollectionWorkerRunTransactionStore({
      runtimeRoot,
      now: () => fixtureNow,
      faultInjector: oneShotFault("after_run_output_rename_before_marker"),
    });
    await expectCode(
      faultedStore.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact }),
      "FIXTURE_TRANSACTION_FAULT",
    );
    const outputNames = await fsp.readdir(path.join(runtimeRoot, "outputs"));
    assert.equal(outputNames.length, 1);
    const finalRoot = path.join(runtimeRoot, "outputs", outputNames[0]);
    await fsp.appendFile(path.join(finalRoot, "platform.csv"), "tampered\n", "utf8");
    const restartedStore = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    await expectCode(
      restartedStore.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact }),
      "COLLECTION_RUN_OUTPUT_HASH_MISMATCH",
    );
    assert.equal(await restartedStore.isCommittedRunOutputValid({ runId: outputNames[0] }), false);
    assert.equal((await restartedStore.readRunOutputJournal()).committed.length, 0);
    assertVisibleCounts(await restartedStore.readVisibleState(), {
      runs: 0,
      companies: 0,
      products: 0,
      revenues: 0,
      history: 0,
    });
  });
}

async function testV2RunBundleProjectionMarkerTamperFailsClosed() {
  await temporaryRuntime("run-projection-tamper", async (runtimeRoot) => {
    const signedArtifact = makeV2RunArtifact();
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact });
    assertVisibleCounts(await store.readVisibleState());
    const markerPath = path.join(store.runOutputCommittedRoot, `${committed.transactionId}.json`);
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
    marker.projections.revenues[0].estimatedRevenue += 1;
    await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
    await assert.rejects(store.readVisibleState(), /failed validation/iu);
    assert.equal(await store.isCommittedRunOutputValid({ runId: committed.runId }), false);
  });
}

async function testDerivedTrafficCacheCompatibilityIsReadOnlyAndNarrow() {
  await temporaryRuntime("derived-traffic-cache", async (runtimeRoot) => {
    const signedArtifact = makeV2RunArtifact();
    const store = createCollectionWorkerRunTransactionStore({ runtimeRoot, now: () => fixtureNow });
    const committed = await store.finalizeVerifiedRunBundle({ signedArtifact, verifier: verifiedV2Artifact });
    const outputRoot = path.join(runtimeRoot, committed.finalRelativePath);

    await fsp.writeFile(path.join(outputRoot, "traffic_metrics.json"), "{}", "utf8");
    assert.equal(
      await store.isCommittedRunOutputValid({ runId: committed.runId }),
      false,
      "normal transaction validation must keep the signed file set exact",
    );
    assert.equal(
      await store.isCommittedRunOutputValid({
        runId: committed.runId,
        allowDerivedTrafficCache: true,
      }),
      true,
      "the read-only compatibility path may ignore only the historical traffic cache",
    );

    await fsp.writeFile(path.join(outputRoot, "unexpected-extra.json"), "{}", "utf8");
    assert.equal(
      await store.isCommittedRunOutputValid({
        runId: committed.runId,
        allowDerivedTrafficCache: true,
      }),
      false,
      "an arbitrary extra file must remain fail-closed",
    );
  });
}

async function main() {
  try {
    await testReadyCommitAndReplay();
    await testProviderConfirmedZero();
    await testRejectedArtifactsHaveNoVisibleEffects();
    await testFaultsBeforeCommitRemainInvisibleAndRecover();
    await testResponseLossAfterCommitIsExactlyOnce();
    await testRevisionCasAndConcurrentFinalizers();
    await testCommittedMarkerTamperFailsClosed();
    await testV2RunBundleAtomicPublishAndReplay();
    await testV2RunBundleConcurrentFinalizers();
    await testV2RunBundleFaultRecovery();
    await testV2RunBundleRejectsConflictsAndUnsafeArtifacts();
    await testV2RunBundleTamperAfterRenameFailsClosed();
    await testV2RunBundleProjectionMarkerTamperFailsClosed();
    await testDerivedTrafficCacheCompatibilityIsReadOnlyAndNarrow();
    assert.equal(unexpectedNetworkCalls, 0);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      resultCount: 20,
      zeroIsTerminal: true,
      missingIsTerminal: false,
      faultPoints: 4,
      concurrentFinalizers: 12,
      runOutputFaultPoints: 7,
      runOutputConcurrentFinalizers: 10,
      runOutputAtomicRename: true,
      externalNetworkCalls: unexpectedNetworkCalls,
    })}\n`);
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  global.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
