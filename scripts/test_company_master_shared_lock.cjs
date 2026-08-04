"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  CompanyMasterLockBusyError,
  CompanyMasterLockOwnershipError,
  CompanyMasterLockUnsafePathError,
  LOCK_KIND,
  LOCK_SCHEMA_VERSION,
  acquireCompanyMasterSharedLock,
  createCompanyMasterSharedLock,
  inspectCompanyMasterSharedLock,
  lockPathForTarget,
  withCompanyMasterSharedLock
} = require("./company_master_shared_lock.cjs");

async function expectReject(task, ErrorType, pattern) {
  await assert.rejects(task, (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, received ${error?.constructor?.name}`);
    if (pattern) assert.match(String(error.message || ""), pattern);
    return true;
  });
}

async function createMaster(directory, name = "companies.json") {
  const target = path.join(directory, name);
  await fsp.writeFile(target, `${JSON.stringify({ version: 1, companies: {} })}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

async function tryDirectoryJunction(target, linkPath) {
  try {
    await fsp.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error?.code)) return false;
    throw error;
  }
}

function waitForChildMarker(child, marker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`child did not emit ${marker}: ${stderr}`)), timeoutMs);
    const finish = () => {
      if (!stdout.includes(marker)) return;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      finish();
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => {
      if (stdout.includes(marker)) return;
      clearTimeout(timer);
      reject(new Error(`child exited before ${marker} with ${code}: ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child lock fixture did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "company-master-shared-lock-"));
  const allowedRoot = path.join(tempRoot, "runtime");
  const outsideRoot = path.join(tempRoot, "outside");
  await fsp.mkdir(allowedRoot, { recursive: true });
  await fsp.mkdir(outsideRoot, { recursive: true });
  const target = await createMaster(allowedRoot);
  const lockPath = lockPathForTarget(target);

  try {
    assert.equal(
      path.basename(lockPath),
      ".companies.json.company-master.lock",
      "server and CLI must derive one deterministic adjacent lock path"
    );

    const first = await acquireCompanyMasterSharedLock(target, {
      allowedRoot,
      purpose: "server-company-master-write"
    });
    assert.equal(first.targetPath, path.resolve(target));
    assert.equal(Object.prototype.hasOwnProperty.call(first.owner, "token"), false, "public owner metadata must not expose the release token");
    assert.match(first.owner.tokenHash, /^[a-f0-9]{64}$/);

    const held = await inspectCompanyMasterSharedLock(target, { allowedRoot });
    assert.equal(held.status, "held");
    assert.equal(held.owner.purpose, "server-company-master-write");
    assert.equal(held.owner.tokenHash, first.owner.tokenHash);
    assert.equal(held.stalePolicy, "report-only-never-auto-delete");

    const persistedRecord = JSON.parse(await fsp.readFile(lockPath, "utf8"));
    assert.equal(persistedRecord.kind, LOCK_KIND);
    assert.equal(persistedRecord.schemaVersion, LOCK_SCHEMA_VERSION);
    assert.match(persistedRecord.token, /^[a-f0-9]{64}$/);
    assert.equal(persistedRecord.targetPath, path.resolve(target));
    if (process.platform !== "win32") {
      const mode = (await fsp.stat(lockPath)).mode & 0o777;
      assert.equal(mode, 0o600, "lock ownership metadata must be private");
    }

    await expectReject(
      () => acquireCompanyMasterSharedLock(target, { allowedRoot, timeoutMs: 0 }),
      CompanyMasterLockBusyError,
      /already held/
    );
    assert.equal(await fsp.readFile(lockPath, "utf8").then(() => true), true, "contention must not delete the owner lock");

    const releaseFirst = new Promise((resolve, reject) => {
      setTimeout(() => first.release().then(resolve, reject), 35);
    });
    const waited = await acquireCompanyMasterSharedLock(target, {
      allowedRoot,
      purpose: "geocoding-dry-run",
      timeoutMs: 500,
      pollIntervalMs: 10
    });
    await releaseFirst;
    assert.equal(waited.owner.purpose, "geocoding-dry-run");
    assert.equal(await waited.release(), true);
    assert.equal(await waited.release(), false, "release must be idempotent for its owner handle");
    await assert.rejects(() => fsp.lstat(lockPath), (error) => error?.code === "ENOENT");

    const missingTarget = path.join(allowedRoot, "new-companies.json");
    const missingLockPath = lockPathForTarget(missingTarget);
    const missingOwner = await acquireCompanyMasterSharedLock(missingTarget, {
      allowedRoot,
      allowMissingTarget: true,
      purpose: "initial-company-master-create"
    });
    assert.equal(missingOwner.targetPath, path.resolve(missingTarget));
    assert.equal((await inspectCompanyMasterSharedLock(missingTarget, {
      allowedRoot,
      allowMissingTarget: true
    })).status, "held");
    await expectReject(
      () => acquireCompanyMasterSharedLock(missingTarget, {
        allowedRoot,
        allowMissingTarget: true,
        timeoutMs: 0
      }),
      CompanyMasterLockBusyError
    );
    await missingOwner.release();
    await assert.rejects(() => fsp.lstat(missingTarget), (error) => error?.code === "ENOENT");
    await assert.rejects(() => fsp.lstat(missingLockPath), (error) => error?.code === "ENOENT");
    await expectReject(
      () => acquireCompanyMasterSharedLock(missingTarget, { allowedRoot }),
      CompanyMasterLockUnsafePathError,
      /must already exist/
    );
    await expectReject(
      () => acquireCompanyMasterSharedLock(path.join(allowedRoot, "missing-parent", "companies.json"), {
        allowedRoot,
        allowMissingTarget: true
      }),
      CompanyMasterLockUnsafePathError,
      /parent must already exist/
    );

    const modulePath = require.resolve("./company_master_shared_lock.cjs");
    const childCode = `
      const { acquireCompanyMasterSharedLock } = require(${JSON.stringify(modulePath)});
      (async () => {
        const lock = await acquireCompanyMasterSharedLock(${JSON.stringify(target)}, {
          allowedRoot: ${JSON.stringify(allowedRoot)},
          purpose: "cross-process-owner"
        });
        process.stdout.write("LOCKED\\n");
        setTimeout(async () => {
          await lock.release();
          process.exit(0);
        }, 200);
      })().catch((error) => {
        process.stderr.write(String(error && (error.stack || error)));
        process.exit(1);
      });
    `;
    const child = spawn(process.execPath, ["-e", childCode], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await waitForChildMarker(child, "LOCKED");
    await expectReject(
      () => acquireCompanyMasterSharedLock(target, { allowedRoot, timeoutMs: 0 }),
      CompanyMasterLockBusyError
    );
    assert.equal(await waitForChildExit(child), 0);
    const afterChild = await acquireCompanyMasterSharedLock(target, {
      allowedRoot,
      purpose: "cross-process-successor"
    });
    await afterChild.release();

    const abortOwner = await acquireCompanyMasterSharedLock(target, { allowedRoot, purpose: "abort-owner" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => acquireCompanyMasterSharedLock(target, {
        allowedRoot,
        timeoutMs: 500,
        pollIntervalMs: 10,
        signal: controller.signal
      }),
      (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
    );
    await abortOwner.release();

    const staleClock = { value: Date.now() };
    const staleRuntime = createCompanyMasterSharedLock({ now: () => new Date(staleClock.value) });
    const staleOwner = await staleRuntime.acquireCompanyMasterSharedLock(target, {
      allowedRoot,
      purpose: "crash-simulation"
    });
    staleClock.value += 60_000;
    const staleState = await staleRuntime.inspectCompanyMasterSharedLock(target, {
      allowedRoot,
      staleAfterMs: 1_000
    });
    assert.equal(staleState.status, "held");
    assert.equal(staleState.isStale, true);
    await expectReject(
      () => staleRuntime.acquireCompanyMasterSharedLock(target, {
        allowedRoot,
        timeoutMs: 0,
        staleAfterMs: 1_000
      }),
      CompanyMasterLockBusyError
    );
    assert.equal(await fsp.readFile(lockPath, "utf8").then(() => true), true, "stale locks must never be auto-deleted");
    await staleOwner.release();

    await fsp.writeFile(lockPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fsp.utimes(lockPath, old, old);
    const malformed = await inspectCompanyMasterSharedLock(target, { allowedRoot, staleAfterMs: 1 });
    assert.equal(malformed.status, "malformed");
    assert.equal(malformed.isStale, true);
    await expectReject(
      () => acquireCompanyMasterSharedLock(target, { allowedRoot, timeoutMs: 0, staleAfterMs: 1 }),
      CompanyMasterLockBusyError
    );
    assert.equal((await fsp.lstat(lockPath)).isFile(), true, "partial crash records must remain for operator review");
    await fsp.unlink(lockPath);

    const orphanRecord = {
      kind: LOCK_KIND,
      schemaVersion: LOCK_SCHEMA_VERSION,
      token: "a".repeat(64),
      targetPath: path.resolve(target),
      purpose: "orphaned-preview-maintenance",
      pid: 999999,
      hostname: "retired-instance",
      createdAt: "2000-01-01T00:00:00.000Z"
    };
    await fsp.writeFile(lockPath, `${JSON.stringify(orphanRecord)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const orphan = await inspectCompanyMasterSharedLock(target, { allowedRoot, staleAfterMs: 1 });
    assert.equal(orphan.status, "held");
    assert.equal(orphan.isStale, true);
    assert.equal(orphan.owner.token, undefined);
    await expectReject(
      () => acquireCompanyMasterSharedLock(target, { allowedRoot, timeoutMs: 0, staleAfterMs: 1 }),
      CompanyMasterLockBusyError
    );
    assert.equal((await fsp.lstat(lockPath)).isFile(), true, "orphaned crash lock must require explicit operator recovery");
    await fsp.unlink(lockPath);

    const tokenOwner = await acquireCompanyMasterSharedLock(target, { allowedRoot, purpose: "token-owner" });
    const replaced = JSON.parse(await fsp.readFile(lockPath, "utf8"));
    replaced.token = "b".repeat(64);
    await fsp.writeFile(lockPath, `${JSON.stringify(replaced)}\n`, "utf8");
    await expectReject(() => tokenOwner.release(), CompanyMasterLockOwnershipError, /token/);
    assert.equal((await fsp.lstat(lockPath)).isFile(), true, "a release token mismatch must not unlink another owner record");
    await fsp.unlink(lockPath);

    assert.equal(await withCompanyMasterSharedLock(
      target,
      { allowedRoot, purpose: "with-lock-success" },
      async () => 42
    ), 42);
    await assert.rejects(
      () => withCompanyMasterSharedLock(
        target,
        { allowedRoot, purpose: "with-lock-failure" },
        async () => { throw new Error("fixture task failed"); }
      ),
      /fixture task failed/
    );
    await assert.rejects(() => fsp.lstat(lockPath), (error) => error?.code === "ENOENT");

    const outsideTarget = await createMaster(outsideRoot);
    await expectReject(
      () => acquireCompanyMasterSharedLock(outsideTarget, { allowedRoot }),
      CompanyMasterLockUnsafePathError,
      /escapes/
    );
    await expectReject(
      () => acquireCompanyMasterSharedLock(path.relative(process.cwd(), target), { allowedRoot }),
      CompanyMasterLockUnsafePathError,
      /absolute/
    );
    await expectReject(
      () => acquireCompanyMasterSharedLock(target, { allowedRoot: path.relative(process.cwd(), allowedRoot) }),
      CompanyMasterLockUnsafePathError,
      /allowedRoot/
    );

    const rootJunction = path.join(tempRoot, "runtime-link");
    if (await tryDirectoryJunction(allowedRoot, rootJunction)) {
      await expectReject(
        () => acquireCompanyMasterSharedLock(path.join(rootJunction, "companies.json"), { allowedRoot: rootJunction }),
        CompanyMasterLockUnsafePathError,
        /real directory/
      );
      await fsp.unlink(rootJunction);
    }

    const escapeJunction = path.join(allowedRoot, "escape-link");
    if (await tryDirectoryJunction(outsideRoot, escapeJunction)) {
      await expectReject(
        () => acquireCompanyMasterSharedLock(path.join(escapeJunction, "companies.json"), { allowedRoot }),
        CompanyMasterLockUnsafePathError,
        /symbolic links|leave allowedRoot/
      );
      await fsp.unlink(escapeJunction);
    }

    const lockJunction = lockPathForTarget(target);
    if (await tryDirectoryJunction(outsideRoot, lockJunction)) {
      await expectReject(
        () => acquireCompanyMasterSharedLock(target, { allowedRoot, timeoutMs: 0 }),
        CompanyMasterLockUnsafePathError,
        /lock path/
      );
      await fsp.unlink(lockJunction);
    }

    console.log("Company master shared lock tests passed using temporary fixtures only");
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
