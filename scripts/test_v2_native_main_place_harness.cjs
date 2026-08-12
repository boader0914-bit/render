"use strict";

process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  BASELINE_COLLECTOR_BLOB,
  BASELINE_COMMIT,
  normalizeJob,
  readAndVerifySourceManifest,
  runPair
} = require("./v2_native_main_place_harness.cjs");

const SECRET = "phase1-secret-must-never-appear";
const job = Object.freeze({
  schemaVersion: "v2-native-main-place-job.v1",
  runId: "offline-harness-test-001",
  mode: "offline",
  keyword: "Synthetic regional lodging",
  checkIn: "2026-08-13",
  checkOut: "2026-08-13",
  timeoutMs: 25000
});

async function allFiles(root) {
  const result = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  await visit(root);
  return result;
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 native main-place harness test" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-native-main-place-harness-test-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-native-main-place-outside-"));
  const sentinel = path.join(outsideRoot, "sentinel.txt");
  await fs.writeFile(sentinel, "unchanged", "utf8");
  process.env.V2_NATIVE_TEST_SECRET = SECRET;
  try {
    const verified = await readAndVerifySourceManifest();
    assert.equal(verified.manifest.baselineCommit, BASELINE_COMMIT);
    assert.equal(verified.manifest.baselineCollectorBlob, BASELINE_COLLECTOR_BLOB);

    assert.throws(() => normalizeJob({ ...job, unexpected: true }), (error) => error?.code === "V2_NATIVE_JOB_INVALID");
    assert.throws(() => normalizeJob({ ...job, keyword: "bad\nkeyword" }), (error) => error?.code === "V2_NATIVE_JOB_INVALID");
    assert.throws(() => normalizeJob({ ...job, checkOut: "2026-08-14" }), (error) => error?.code === "V2_NATIVE_JOB_INVALID");

    const result = await runPair(job, { evidenceRoot: root, allowTestRoot: true });
    assert.equal(result.mode, "offline");
    assert.equal(result.actualExternalRequestCount, 0);
    assert.equal(result.automaticRetries, 0);
    assert.equal(result.automaticFallbacks, 0);
    assert.equal(result.operationalWrites, 0);
    assert.equal(result.rawProviderResponsesStored, false);
    assert.equal(result.original.providerCallCount, 1);
    assert.equal(result.copied.providerCallCount, 1);
    assert.equal(result.original.fixtureAudit.callCount, 1);
    assert.equal(result.copied.fixtureAudit.callCount, 1);
    assert.equal(result.comparison.structuralParity, true);
    assert.equal(result.comparison.exactParity, true);
    assert.equal(result.comparison.liveObservation, null);
    assert.equal(result.replay.matched, true);
    assert.equal(result.replay.stableIdsMatched, true);
    assert.equal(result.replay.fieldPresenceMatched, true);
    assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged");

    for (const filePath of await allFiles(root)) {
      const content = await fs.readFile(filePath);
      assert.equal(content.includes(Buffer.from(SECRET)), false, `secret leaked to ${path.basename(filePath)}`);
    }

    await assert.rejects(
      runPair(job, { evidenceRoot: root, allowTestRoot: true }),
      (error) => error?.code === "V2_NATIVE_RUN_ALREADY_EXISTS"
    );
    await assert.rejects(
      runPair({ ...job, runId: "outside-path-test-001" }, { evidenceRoot: outsideRoot }),
      (error) => error?.code === "V2_NATIVE_OUTPUT_PATH_INVALID"
    );

    await assert.rejects(
      runPair({ ...job, runId: "live-gate-test-001", mode: "live" }, { evidenceRoot: root, allowTestRoot: true }),
      (error) => error?.code === "V2_NATIVE_LIVE_APPROVAL_REQUIRED"
    );
    process.env.V2_NATIVE_MAIN_PLACE_LIVE_APPROVED = "N1-Live";
    process.env.V2_NATIVE_MAIN_PLACE_LIVE_PAIR_BUDGET = "2";
    process.env.V2_NATIVE_MAIN_PLACE_APPROVED_JOB_SHA256 = "0".repeat(64);
    await assert.rejects(
      runPair({ ...job, runId: "live-digest-gate-test-001", mode: "live" }, { evidenceRoot: root, allowTestRoot: true }),
      (error) => error?.code === "V2_NATIVE_LIVE_APPROVAL_REQUIRED"
    );
    assert.equal(guard.blockedAttempts(), 0);
    console.log("V2 native main-place harness fixtures passed (2 child fixture calls, 0 external requests)");
  } finally {
    guard.restore();
    delete process.env.V2_NATIVE_TEST_SECRET;
    delete process.env.V2_NATIVE_MAIN_PLACE_LIVE_APPROVED;
    delete process.env.V2_NATIVE_MAIN_PLACE_LIVE_PAIR_BUDGET;
    delete process.env.V2_NATIVE_MAIN_PLACE_APPROVED_JOB_SHA256;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
