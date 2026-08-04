"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const LOCK_KIND = "lodging-company-master-shared-lock";
const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 0;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOCK_BYTES = 16 * 1024;

class CompanyMasterLockError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

class CompanyMasterLockBusyError extends CompanyMasterLockError {
  constructor(message, details = {}) {
    super(message, "COMPANY_MASTER_LOCK_BUSY", details);
  }
}

class CompanyMasterLockUnsafePathError extends CompanyMasterLockError {
  constructor(message, details = {}) {
    super(message, "COMPANY_MASTER_LOCK_UNSAFE_PATH", details);
  }
}

class CompanyMasterLockOwnershipError extends CompanyMasterLockError {
  constructor(message, details = {}) {
    super(message, "COMPANY_MASTER_LOCK_OWNERSHIP_LOST", details);
  }
}

function abortError() {
  const error = new Error("company master lock acquisition aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function finiteInteger(value, fallback, minimum, maximum, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function samePath(left, right, platform = process.platform) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function pathInside(candidate, root, platform = process.platform) {
  const normalizedCandidate = platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  const normalizedRoot = platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lockPathForTarget(targetPath) {
  const target = path.resolve(targetPath);
  return path.join(path.dirname(target), `.${path.basename(target)}.company-master.lock`);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safePurpose(value) {
  const purpose = String(value || "company-master-write").trim();
  if (!purpose || purpose.length > 100 || /[\u0000-\u001f\u007f]/.test(purpose)) {
    throw new TypeError("company master lock purpose must be 1-100 printable characters");
  }
  return purpose;
}

function publicRecord(record, observedAt, staleAfterMs) {
  const createdMs = Date.parse(record.createdAt);
  const observedMs = Date.parse(observedAt);
  const ageMs = Number.isFinite(createdMs) && Number.isFinite(observedMs)
    ? Math.max(0, observedMs - createdMs)
    : null;
  return {
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    targetPath: record.targetPath,
    purpose: record.purpose,
    pid: record.pid,
    hostname: record.hostname,
    createdAt: record.createdAt,
    tokenHash: tokenHash(record.token),
    ageMs,
    isStale: ageMs !== null && ageMs >= staleAfterMs
  };
}

function validateRecord(record, expectedTarget) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.kind !== LOCK_KIND || record.schemaVersion !== LOCK_SCHEMA_VERSION) return false;
  if (!/^[a-f0-9]{64}$/.test(String(record.token || ""))) return false;
  if (!path.isAbsolute(String(record.targetPath || ""))) return false;
  if (!samePath(record.targetPath, expectedTarget)) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (!String(record.hostname || "").trim() || String(record.hostname).length > 255) return false;
  if (!String(record.purpose || "").trim() || String(record.purpose).length > 100) return false;
  if (!Number.isFinite(Date.parse(record.createdAt))) return false;
  return true;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (left.dev !== undefined && right.dev !== undefined && left.ino !== undefined && right.ino !== undefined) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs;
}

function createCompanyMasterSharedLock(dependencies = {}) {
  const fsApi = dependencies.fs || fsp;
  const randomBytes = dependencies.randomBytes || crypto.randomBytes;
  const now = dependencies.now || (() => new Date());
  const hostname = dependencies.hostname || os.hostname;
  const pid = dependencies.pid || process.pid;
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function hardenFile(filePath) {
    await fsApi.chmod(filePath, 0o600).catch((error) => {
      if (!["ENOSYS", "ENOTSUP", "EPERM", "EACCES"].includes(error?.code)) throw error;
    });
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await fsApi.open(directory, "r");
      await handle.sync();
    } catch {
      // Directory fsync is a best-effort durability step after the atomic
      // create/unlink commit point. It must not report a false lock failure.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function resolveTarget(targetPath, allowedRoot, allowMissingTarget = false) {
    if (!targetPath || !path.isAbsolute(String(targetPath))) {
      throw new CompanyMasterLockUnsafePathError("company master target must be an absolute path");
    }
    if (!allowedRoot || !path.isAbsolute(String(allowedRoot))) {
      throw new CompanyMasterLockUnsafePathError("company master lock requires an explicit absolute allowedRoot");
    }

    const lexicalRoot = path.resolve(allowedRoot);
    const lexicalTarget = path.resolve(targetPath);
    if (!pathInside(lexicalTarget, lexicalRoot)) {
      throw new CompanyMasterLockUnsafePathError("company master target escapes the allowed root", {
        targetPath: lexicalTarget,
        allowedRoot: lexicalRoot
      });
    }

    let rootEntry;
    try {
      rootEntry = await fsApi.lstat(lexicalRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CompanyMasterLockUnsafePathError("company master allowed root must already exist", {
          targetPath: lexicalTarget,
          allowedRoot: lexicalRoot
        });
      }
      throw error;
    }
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new CompanyMasterLockUnsafePathError("company master allowed root must be a real directory");
    }

    const realRoot = path.resolve(await fsApi.realpath(lexicalRoot));
    const lexicalParent = path.dirname(lexicalTarget);
    let parentEntry;
    try {
      parentEntry = await fsApi.lstat(lexicalParent);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CompanyMasterLockUnsafePathError("company master target parent must already exist", {
          targetPath: lexicalTarget,
          allowedRoot: lexicalRoot
        });
      }
      throw error;
    }
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
      throw new CompanyMasterLockUnsafePathError("company master target parent must be a real directory and must not traverse symbolic links");
    }
    const realParent = path.resolve(await fsApi.realpath(lexicalParent));
    if (!samePath(lexicalRoot, realRoot)
      || !samePath(lexicalParent, realParent)
      || !pathInside(realParent, realRoot)) {
      throw new CompanyMasterLockUnsafePathError("company master target must not traverse symbolic links or leave allowedRoot", {
        targetPath: lexicalTarget,
        allowedRoot: lexicalRoot
      });
    }

    let targetEntry;
    try {
      targetEntry = await fsApi.lstat(lexicalTarget);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!allowMissingTarget) {
        throw new CompanyMasterLockUnsafePathError("company master target must already exist", {
          targetPath: lexicalTarget,
          allowedRoot: lexicalRoot
        });
      }
    }

    let realTarget = path.join(realParent, path.basename(lexicalTarget));
    if (targetEntry) {
      if (targetEntry.isSymbolicLink() || !targetEntry.isFile()) {
        throw new CompanyMasterLockUnsafePathError("company master target must be a real regular file");
      }
      realTarget = path.resolve(await fsApi.realpath(lexicalTarget));
      if (!samePath(lexicalTarget, realTarget) || !pathInside(realTarget, realRoot)) {
        throw new CompanyMasterLockUnsafePathError("company master target must not traverse symbolic links or leave allowedRoot", {
          targetPath: lexicalTarget,
          allowedRoot: lexicalRoot
        });
      }
    }

    return {
      allowedRoot: realRoot,
      targetPath: realTarget,
      targetExists: Boolean(targetEntry),
      parentPath: realParent,
      lockPath: lockPathForTarget(realTarget)
    };
  }

  async function readLock(context, staleAfterMs) {
    let entry;
    try {
      entry = await fsApi.lstat(context.lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { status: "free", lockPath: context.lockPath, owner: null, entry: null, record: null };
      }
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new CompanyMasterLockUnsafePathError("company master lock path is not a regular file", {
        lockPath: context.lockPath
      });
    }
    if (entry.size > MAX_LOCK_BYTES) {
      return {
        status: "malformed",
        lockPath: context.lockPath,
        owner: null,
        entry,
        record: null,
        isStale: Math.max(0, now().getTime() - entry.mtimeMs) >= staleAfterMs
      };
    }

    let record;
    try {
      const raw = await fsApi.readFile(context.lockPath, "utf8");
      record = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
    } catch {
      return {
        status: "malformed",
        lockPath: context.lockPath,
        owner: null,
        entry,
        record: null,
        isStale: Math.max(0, now().getTime() - entry.mtimeMs) >= staleAfterMs
      };
    }
    if (!validateRecord(record, context.targetPath)) {
      return {
        status: "malformed",
        lockPath: context.lockPath,
        owner: null,
        entry,
        record: null,
        isStale: Math.max(0, now().getTime() - entry.mtimeMs) >= staleAfterMs
      };
    }
    const observedAt = now().toISOString();
    const owner = publicRecord(record, observedAt, staleAfterMs);
    return {
      status: "held",
      lockPath: context.lockPath,
      owner,
      entry,
      record,
      isStale: owner.isStale
    };
  }

  async function inspectCompanyMasterSharedLock(targetPath, options = {}) {
    const staleAfterMs = finiteInteger(
      options.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
      0,
      Number.MAX_SAFE_INTEGER,
      "staleAfterMs"
    );
    const context = await resolveTarget(targetPath, options.allowedRoot, options.allowMissingTarget === true);
    const state = await readLock(context, staleAfterMs);
    return {
      status: state.status,
      targetPath: context.targetPath,
      lockPath: context.lockPath,
      owner: state.owner,
      isStale: Boolean(state.isStale),
      stalePolicy: "report-only-never-auto-delete"
    };
  }

  async function cleanupFailedAcquire(lockPath, createdEntry) {
    try {
      const current = await fsApi.lstat(lockPath);
      if (current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, createdEntry)) {
        await fsApi.unlink(lockPath);
        await syncDirectory(path.dirname(lockPath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async function acquireCompanyMasterSharedLock(targetPath, options = {}) {
    const timeoutMs = finiteInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS, "timeoutMs");
    const pollIntervalMs = finiteInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      5,
      5000,
      "pollIntervalMs"
    );
    const staleAfterMs = finiteInteger(
      options.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
      0,
      Number.MAX_SAFE_INTEGER,
      "staleAfterMs"
    );
    const purpose = safePurpose(options.purpose);
    const signal = options.signal;
    const allowMissingTarget = options.allowMissingTarget === true;
    const context = await resolveTarget(targetPath, options.allowedRoot, allowMissingTarget);
    const startedAt = now().getTime();

    while (true) {
      if (signal?.aborted) throw abortError();
      const token = randomBytes(32).toString("hex");
      const record = {
        kind: LOCK_KIND,
        schemaVersion: LOCK_SCHEMA_VERSION,
        token,
        targetPath: context.targetPath,
        purpose,
        pid,
        hostname: String(hostname()),
        createdAt: now().toISOString()
      };

      let handle;
      try {
        handle = await fsApi.open(context.lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const state = await readLock(context, staleAfterMs);
        // The owner can release between our failed exclusive create and the
        // observation. Retry immediately instead of reporting a false busy
        // result when the path is already free.
        if (state.status === "free") continue;
        const elapsedMs = Math.max(0, now().getTime() - startedAt);
        if (elapsedMs >= timeoutMs) {
          throw new CompanyMasterLockBusyError("company master lock is already held", {
            targetPath: context.targetPath,
            lockPath: context.lockPath,
            timeoutMs,
            state: state.status,
            isStale: Boolean(state.isStale),
            owner: state.owner
          });
        }
        const remainingMs = timeoutMs - elapsedMs;
        await sleep(Math.min(pollIntervalMs, remainingMs));
        continue;
      }

      let createdEntry;
      try {
        createdEntry = await handle.stat();
        const stableContext = await resolveTarget(targetPath, options.allowedRoot, allowMissingTarget);
        if (!samePath(stableContext.targetPath, context.targetPath)
          || !samePath(stableContext.parentPath, context.parentPath)
          || !samePath(stableContext.lockPath, context.lockPath)) {
          throw new CompanyMasterLockUnsafePathError("company master target changed during lock acquisition", {
            targetPath: context.targetPath,
            allowedRoot: context.allowedRoot
          });
        }
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await hardenFile(context.lockPath);
        const committedEntry = await fsApi.lstat(context.lockPath);
        if (!committedEntry.isFile()
          || committedEntry.isSymbolicLink()
          || !sameFileIdentity(committedEntry, createdEntry)) {
          throw new CompanyMasterLockOwnershipError("company master lock changed during acquisition", {
            lockPath: context.lockPath
          });
        }
        await syncDirectory(context.parentPath);
      } catch (error) {
        await handle?.close().catch(() => {});
        if (createdEntry) await cleanupFailedAcquire(context.lockPath, createdEntry).catch(() => {});
        throw error;
      }

      let released = false;
      const owner = publicRecord(record, now().toISOString(), staleAfterMs);
      return {
        targetPath: context.targetPath,
        lockPath: context.lockPath,
        owner,
        async release() {
          if (released) return false;
          let currentEntry;
          try {
            currentEntry = await fsApi.lstat(context.lockPath);
          } catch (error) {
            if (error?.code === "ENOENT") {
              throw new CompanyMasterLockOwnershipError("company master lock disappeared before release", {
                lockPath: context.lockPath
              });
            }
            throw error;
          }
          if (!currentEntry.isFile()
            || currentEntry.isSymbolicLink()
            || !sameFileIdentity(currentEntry, createdEntry)) {
            throw new CompanyMasterLockOwnershipError("company master lock ownership changed before release", {
              lockPath: context.lockPath
            });
          }

          let persisted;
          try {
            persisted = JSON.parse(String(await fsApi.readFile(context.lockPath, "utf8")).replace(/^\uFEFF/, ""));
          } catch {
            throw new CompanyMasterLockOwnershipError("company master lock record is unreadable during release", {
              lockPath: context.lockPath
            });
          }
          if (!validateRecord(persisted, context.targetPath) || !safeTokenEqual(persisted.token, token)) {
            throw new CompanyMasterLockOwnershipError("company master lock token does not match the owner", {
              lockPath: context.lockPath
            });
          }
          await fsApi.unlink(context.lockPath);
          released = true;
          await syncDirectory(context.parentPath);
          return true;
        }
      };
    }
  }

  async function withCompanyMasterSharedLock(targetPath, options, task) {
    if (typeof task !== "function") throw new TypeError("company master lock task must be a function");
    const lock = await acquireCompanyMasterSharedLock(targetPath, options);
    let value;
    let taskError;
    try {
      value = await task(lock);
    } catch (error) {
      taskError = error;
    }

    let releaseError;
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
    if (taskError && releaseError) {
      throw new AggregateError([taskError, releaseError], "company master task and lock release both failed");
    }
    if (taskError) throw taskError;
    if (releaseError) throw releaseError;
    return value;
  }

  return {
    acquireCompanyMasterSharedLock,
    inspectCompanyMasterSharedLock,
    withCompanyMasterSharedLock
  };
}

const defaultLock = createCompanyMasterSharedLock();

module.exports = {
  CompanyMasterLockBusyError,
  CompanyMasterLockError,
  CompanyMasterLockOwnershipError,
  CompanyMasterLockUnsafePathError,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STALE_AFTER_MS,
  LOCK_KIND,
  LOCK_SCHEMA_VERSION,
  acquireCompanyMasterSharedLock: defaultLock.acquireCompanyMasterSharedLock,
  createCompanyMasterSharedLock,
  inspectCompanyMasterSharedLock: defaultLock.inspectCompanyMasterSharedLock,
  lockPathForTarget,
  withCompanyMasterSharedLock: defaultLock.withCompanyMasterSharedLock
};
