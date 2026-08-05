"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { createSecureJsonStore } = require("./secure_json_store.cjs");
const { acquireProviderStoreLock, createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { PROVIDER_ATTEMPT_LEASE_SECONDS } = require("./naver_provider_resilience.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "NAVER provider health store fixtures" });

function safeTempRoot(root) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function main() {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-provider-health-"));
  const outsideRuntimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-provider-outside-"));
  const filePath = path.join(runtimeRoot, "private", "naver-place-health.json");
  const parallelFilePath = path.join(runtimeRoot, "parallel", "naver-place-health.json");
  const abandonedFilePath = path.join(runtimeRoot, "abandoned", "naver-place-health.json");
  const undeletableFilePath = path.join(runtimeRoot, "undeletable", "naver-place-health.json");
  const t0 = "2026-08-05T09:00:00.000Z";
  try {
    assert.throws(
      () => createNaverProviderHealthStore({ filePath: "relative.json", runtimeRoot }),
      /absolute file path/
    );
    assert.throws(
      () => createNaverProviderHealthStore({ filePath: path.join(path.dirname(runtimeRoot), "outside.json"), runtimeRoot }),
      /inside the runtime root/
    );

    const linkedParent = path.join(runtimeRoot, "linked-provider-health");
    await fsp.symlink(outsideRuntimeRoot, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const linkedFilePath = path.join(linkedParent, "naver-place-health.json");
    const linkedStore = createNaverProviderHealthStore({ filePath: linkedFilePath, runtimeRoot });
    await assert.rejects(
      () => linkedStore.read(),
      (error) => error.code === "NAVER_PROVIDER_STORE_PATH_INVALID",
      "an existing parent symlink or junction cannot escape the runtime root"
    );
    await assert.rejects(
      () => linkedStore.beginAttempt({ expectedWorkflowRevision: 0, explicit: true, now: t0 }),
      (error) => error.code === "NAVER_PROVIDER_STORE_PATH_INVALID"
    );
    await assert.rejects(
      () => fsp.stat(path.join(outsideRuntimeRoot, "naver-place-health.json")),
      (error) => error.code === "ENOENT",
      "a rejected path cannot create provider state outside the runtime root"
    );

    const independentA = createNaverProviderHealthStore({
      filePath: parallelFilePath,
      runtimeRoot,
      store: createSecureJsonStore(),
      now: () => new Date(t0)
    });
    const independentB = createNaverProviderHealthStore({
      filePath: parallelFilePath,
      runtimeRoot,
      store: createSecureJsonStore(),
      now: () => new Date(t0)
    });
    const independentReservations = await Promise.allSettled([
      independentA.beginAttempt({ expectedWorkflowRevision: 0, explicit: true, now: t0 }),
      independentB.beginAttempt({ expectedWorkflowRevision: 0, explicit: true, now: t0 })
    ]);
    assert.equal(independentReservations.filter((result) => result.status === "fulfilled").length, 1, "cross-store lock permits one reservation");
    assert.equal(
      independentReservations.filter((result) => result.status === "rejected").every((result) => result.reason.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT"),
      true,
      "the losing independent store observes the durable revision"
    );
    assert.equal((await independentA.read()).workflowRevision, 1);
    await assert.rejects(() => fsp.stat(`${parallelFilePath}.lock`), (error) => error.code === "ENOENT", "the cross-process lock is released");

    await fsp.mkdir(path.dirname(abandonedFilePath), { recursive: true });
    const abandonedLockPath = `${abandonedFilePath}.lock`;
    const abandonedGuardPath = `${abandonedLockPath}.reclaim-path`;
    await fsp.writeFile(abandonedLockPath, "", { mode: 0o600 });
    await fsp.writeFile(abandonedGuardPath, "", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 11 * 60 * 1000);
    await fsp.utimes(abandonedLockPath, staleTime, staleTime);
    await fsp.utimes(abandonedGuardPath, staleTime, staleTime);
    const abandoned = createNaverProviderHealthStore({
      filePath: abandonedFilePath,
      runtimeRoot,
      now: () => new Date(t0)
    });
    const recoveredAbandoned = await abandoned.beginAttempt({
      expectedWorkflowRevision: 0,
      explicit: true,
      now: t0
    });
    assert.equal(recoveredAbandoned.allowed, true, "a stale tokenless lock is recovered under a path-scoped guard");
    assert.equal(recoveredAbandoned.state.workflowRevision, 1);
    await assert.rejects(() => fsp.stat(abandonedLockPath), (error) => error.code === "ENOENT");
    await assert.rejects(() => fsp.stat(abandonedGuardPath), (error) => error.code === "ENOENT");

    await fsp.mkdir(`${undeletableFilePath}.lock`, { recursive: true });
    await fsp.utimes(`${undeletableFilePath}.lock`, staleTime, staleTime);
    const busyStartedAt = Date.now();
    await assert.rejects(
      () => acquireProviderStoreLock(undeletableFilePath, { timeoutMs: 100 }),
      (error) => error.code === "NAVER_PROVIDER_STORE_BUSY" && error.statusCode === 503,
      "an unreclaimable stale lock must stop at the bounded deadline"
    );
    assert.ok(Date.now() - busyStartedAt < 2000, "an unreclaimable stale lock cannot spin forever");

    let reads = 0;
    let updates = 0;
    const atomic = createSecureJsonStore();
    const injectedStore = {
      async readJsonFile(...args) {
        reads += 1;
        return atomic.readJsonFile(...args);
      },
      async updateJsonFile(...args) {
        updates += 1;
        return atomic.updateJsonFile(...args);
      }
    };
    const health = createNaverProviderHealthStore({
      filePath,
      runtimeRoot,
      store: injectedStore,
      now: () => new Date(t0)
    });
    const initial = await health.read();
    assert.equal(initial.state, "closed");
    assert.equal(initial.workflowRevision, 0);
    assert.equal(reads, 1, "the injected read contract is used");
    await assert.rejects(
      () => fsp.stat(filePath),
      (error) => error.code === "ENOENT",
      "reading a default closed state must not create the provider health file"
    );

    const reserved = await health.beginAttempt({
      expectedWorkflowRevision: 0,
      explicit: true,
      now: t0
    });
    assert.equal(reserved.allowed, true);
    assert.equal(reserved.state.workflowRevision, 1);
    assert.equal(updates, 1, "the injected atomic update contract is used");

    const opened = await health.recordBlock({
      expectedWorkflowRevision: 1,
      now: "2026-08-05T09:00:01.000Z",
      failure: {
        subtype: "http_403",
        httpStatus: 403,
        diagnosticId: "crawl-c6ddda12830f",
        rawBody: "secret-body",
        query: "private search term",
        url: "https://example.test/?secret=value",
        headers: { cookie: "secret-cookie", authorization: "secret-token" },
        userId: "private-user"
      }
    });
    assert.equal(opened.state, "open");
    assert.equal(opened.workflowRevision, 2);

    const persistedText = await fsp.readFile(filePath, "utf8");
    assert.doesNotMatch(
      persistedText,
      /secret|private search|example\.test|cookie|authorization|userId|rawBody|query|url|headers/i,
      "the strict store schema persists no request or response material"
    );
    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
      assert.equal((await fsp.stat(path.dirname(filePath))).mode & 0o777, 0o700);
    }

    const reloaded = createNaverProviderHealthStore({
      filePath,
      runtimeRoot,
      now: () => new Date("2026-08-05T09:30:01.000Z")
    });
    assert.deepEqual(await reloaded.read(), opened, "an open circuit survives a process-style store recreation");

    const concurrent = await Promise.allSettled([
      reloaded.beginAttempt({
        expectedWorkflowRevision: 2,
        explicit: true,
        now: opened.retryAt
      }),
      reloaded.beginAttempt({
        expectedWorkflowRevision: 2,
        explicit: true,
        now: opened.retryAt
      }),
      reloaded.beginAttempt({
        expectedWorkflowRevision: 2,
        explicit: true,
        now: opened.retryAt
      })
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "one atomic probe reservation wins");
    const rejected = concurrent.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 2);
    assert.equal(rejected.every((result) => result.reason.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT"), true);

    const afterReservation = await reloaded.read();
    assert.equal(afterReservation.state, "probe_allowed");
    assert.equal(afterReservation.workflowRevision, 3);
    await assert.rejects(
      () => reloaded.recordSuccess({ expectedWorkflowRevision: 2, now: opened.retryAt }),
      (error) => error.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT" && error.statusCode === 409
    );
    const recovered = await reloaded.recordSuccess({
      expectedWorkflowRevision: 3,
      now: new Date(Date.parse(opened.retryAt) + 1000).toISOString()
    });
    assert.equal(recovered.state, "closed");
    assert.equal(recovered.workflowRevision, 4);

    const interruptedAt = new Date(Date.parse(opened.retryAt) + 2000).toISOString();
    const interrupted = await reloaded.beginAttempt({
      expectedWorkflowRevision: 4,
      explicit: true,
      now: interruptedAt
    });
    assert.equal(interrupted.state.state, "probe_allowed");
    const restartedWithReservation = createNaverProviderHealthStore({
      filePath,
      runtimeRoot
    });
    const heartbeatAt = new Date(Date.parse(interruptedAt) + 60_000).toISOString();
    const heartbeat = await restartedWithReservation.refreshAttempt({
      expectedWorkflowRevision: 5,
      now: heartbeatAt
    });
    assert.equal(heartbeat.workflowRevision, 6);
    assert.equal(heartbeat.lastAttemptAt, interruptedAt, "the persisted heartbeat preserves the attempt start");
    assert.equal((await restartedWithReservation.read()).updatedAt, heartbeatAt, "the heartbeat survives store reload");
    const freshReservation = await restartedWithReservation.beginAttempt({
      expectedWorkflowRevision: 6,
      explicit: true,
      now: new Date(Date.parse(heartbeatAt) + 1000).toISOString()
    });
    assert.equal(freshReservation.allowed, false, "a fresh reservation remains single-flight after restart");
    assert.equal(freshReservation.reason, "probe_in_flight");
    const protectedAtOriginalExpiry = await restartedWithReservation.beginAttempt({
      expectedWorkflowRevision: 6,
      explicit: true,
      now: new Date(Date.parse(interruptedAt) + PROVIDER_ATTEMPT_LEASE_SECONDS * 1000).toISOString()
    });
    assert.equal(protectedAtOriginalExpiry.allowed, false, "a live heartbeat extends the cross-process attempt lease");
    const recoveredReservation = await restartedWithReservation.beginAttempt({
      expectedWorkflowRevision: 6,
      explicit: true,
      now: new Date(Date.parse(heartbeatAt) + PROVIDER_ATTEMPT_LEASE_SECONDS * 1000).toISOString()
    });
    assert.equal(recoveredReservation.allowed, true, "a crashed reservation cannot block the provider forever");
    assert.equal(recoveredReservation.reason, "stale_attempt_recovered");
    const closedAfterRecovery = await restartedWithReservation.recordSuccess({
      expectedWorkflowRevision: 7,
      now: new Date(Date.parse(heartbeatAt) + (PROVIDER_ATTEMPT_LEASE_SECONDS + 1) * 1000).toISOString()
    });
    assert.equal(closedAfterRecovery.state, "closed");
    assert.equal(closedAfterRecovery.workflowRevision, 8);

    await fsp.writeFile(filePath, "{\"schemaVersion\":1,\"query\":\"must fail closed\"}\n", "utf8");
    await assert.rejects(() => reloaded.read(), /failed validation/);
    assert.equal(networkGuard.blockedAttempts(), 0);

    console.log("NAVER provider health atomic store, reload, CAS, and corruption tests passed.");
  } finally {
    if (!safeTempRoot(runtimeRoot)) throw new Error(`refusing to remove unexpected temp path: ${runtimeRoot}`);
    if (!safeTempRoot(outsideRuntimeRoot)) throw new Error(`refusing to remove unexpected temp path: ${outsideRuntimeRoot}`);
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
    await fsp.rm(outsideRuntimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  networkGuard.restore();
});
