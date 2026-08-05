"use strict";

const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const secureJsonStore = require("./secure_json_store.cjs");
const {
  beginProviderAttempt,
  createInitialProviderCircuitState,
  refreshProviderAttemptLease,
  recordProviderBlock,
  recordProviderSuccess,
  releaseProviderAttempt,
  revisionConflict,
  validateProviderCircuitState
} = require("./naver_provider_resilience.cjs");

const PROVIDER_STORE_LOCK_TIMEOUT_MS = 10_000;
const PROVIDER_STORE_STALE_LOCK_MS = 10 * 60 * 1000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLockToken(filePath) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return typeof value?.token === "string" ? value.token : "";
  } catch {
    return "";
  }
}

function lockStatIdentity(stat) {
  if (!stat) return null;
  return Object.freeze({
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  });
}

function sameLockStat(left, right) {
  if (!left || !right) return false;
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function acquireReclaimGuard(lockPath, ownerToken, { pathScoped = false, timeoutMs = PROVIDER_STORE_LOCK_TIMEOUT_MS } = {}) {
  if (!pathScoped && !/^[a-f0-9-]{36}$/i.test(String(ownerToken || ""))) {
    const invalid = new Error("NAVER provider health lock owner token is invalid");
    invalid.code = "NAVER_PROVIDER_STORE_LOCK_INVALID";
    throw invalid;
  }
  const guardPath = pathScoped ? `${lockPath}.reclaim-path` : `${lockPath}.reclaim-${ownerToken}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await fsp.open(guardPath, "wx", 0o600);
      return async () => {
        await handle.close().catch(() => {});
        await fsp.rm(guardPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fsp.stat(guardPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > PROVIDER_STORE_STALE_LOCK_MS) {
        const current = await fsp.stat(guardPath).catch(() => null);
        if (sameLockStat(lockStatIdentity(stat), lockStatIdentity(current))) {
          await fsp.rm(guardPath, { force: true }).catch(() => {});
          if (!await fsp.stat(guardPath).catch(() => null)) continue;
        }
      }
      if (Date.now() >= deadline) {
        const busy = new Error("NAVER provider health store reclaim guard is busy");
        busy.code = "NAVER_PROVIDER_STORE_BUSY";
        busy.statusCode = 503;
        throw busy;
      }
      await delay(10);
    }
  }
}

function assertRealPathWithinRoot(rootRealPath, candidateRealPath) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("NAVER provider health store real path escaped the runtime root");
    error.code = "NAVER_PROVIDER_STORE_PATH_INVALID";
    error.statusCode = 500;
    throw error;
  }
}

async function assertProviderStoreRealPathBoundary(target, runtimeRoot) {
  if (!runtimeRoot) return;
  const root = path.resolve(String(runtimeRoot));
  const rootRealPath = await fsp.realpath(root);
  let ancestor = path.dirname(path.resolve(target));
  while (true) {
    try {
      const ancestorRealPath = await fsp.realpath(ancestor);
      assertRealPathWithinRoot(rootRealPath, ancestorRealPath);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (ancestor === root) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const targetRealPath = await fsp.realpath(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (targetRealPath) assertRealPathWithinRoot(rootRealPath, targetRealPath);
}

async function acquireProviderStoreLock(target, options = {}) {
  const lockPath = `${target}.lock`;
  const configuredTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 10
    ? configuredTimeout
    : PROVIDER_STORE_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await assertProviderStoreRealPathBoundary(target, options.runtimeRoot);
  while (true) {
    let handle;
    try {
      const token = crypto.randomUUID();
      handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      return async () => {
        await handle.close().catch(() => {});
        const releaseGuard = await acquireReclaimGuard(lockPath, token, { timeoutMs });
        try {
          if (await readLockToken(lockPath) === token) {
            await fsp.rm(lockPath, { force: true }).catch(() => {});
          }
        } finally {
          await releaseGuard();
        }
      };
    } catch (error) {
      const createdLock = Boolean(handle);
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        if (createdLock) await fsp.rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      const stat = await fsp.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > PROVIDER_STORE_STALE_LOCK_MS) {
        const observedStat = lockStatIdentity(stat);
        const observedToken = await readLockToken(lockPath);
        let reclaimed = false;
        if (!observedToken) {
          const releaseGuard = await acquireReclaimGuard(lockPath, "", { pathScoped: true, timeoutMs });
          try {
            const currentStat = await fsp.stat(lockPath).catch(() => null);
            const currentToken = await readLockToken(lockPath);
            if (
              !currentToken
              && sameLockStat(observedStat, lockStatIdentity(currentStat))
              && Date.now() - currentStat.mtimeMs > PROVIDER_STORE_STALE_LOCK_MS
            ) {
              await fsp.rm(lockPath, { force: true }).catch(() => {});
              reclaimed = !await fsp.stat(lockPath).catch(() => null);
            }
          } finally {
            await releaseGuard();
          }
        } else {
          const releaseGuard = await acquireReclaimGuard(lockPath, observedToken, { timeoutMs });
          try {
            const currentStat = await fsp.stat(lockPath).catch(() => null);
            const currentToken = await readLockToken(lockPath);
            if (
              currentToken === observedToken
              && sameLockStat(observedStat, lockStatIdentity(currentStat))
              && Date.now() - currentStat.mtimeMs > PROVIDER_STORE_STALE_LOCK_MS
            ) {
              await fsp.rm(lockPath, { force: true }).catch(() => {});
              reclaimed = !await fsp.stat(lockPath).catch(() => null);
            }
          } finally {
            await releaseGuard();
          }
        }
        if (reclaimed) continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error("NAVER provider health store is busy");
        busy.code = "NAVER_PROVIDER_STORE_BUSY";
        busy.statusCode = 503;
        throw busy;
      }
      await delay(10);
    }
  }
}

async function withProviderStoreLock(target, task, runtimeRoot = null) {
  const release = await acquireProviderStoreLock(target, { runtimeRoot });
  try {
    await assertProviderStoreRealPathBoundary(target, runtimeRoot);
    return await task();
  } finally {
    await release();
  }
}

function resolvePrivateFixturePath(filePath, runtimeRoot) {
  if (!filePath || !path.isAbsolute(String(filePath))) {
    throw new TypeError("NAVER provider health store requires an absolute file path");
  }
  if (!runtimeRoot || !path.isAbsolute(String(runtimeRoot))) {
    throw new TypeError("NAVER provider health store requires an absolute runtime root");
  }
  const root = path.resolve(String(runtimeRoot));
  const target = path.resolve(String(filePath));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("NAVER provider health store path must remain inside the runtime root");
  }
  return Object.freeze({ root, target });
}

function validateStoreApi(store) {
  if (!store || typeof store.readJsonFile !== "function" || typeof store.updateJsonFile !== "function") {
    throw new TypeError("NAVER provider health store requires atomic readJsonFile and updateJsonFile functions");
  }
  return store;
}

function validateExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("expectedWorkflowRevision must be a non-negative integer");
  }
  return value;
}

function createNaverProviderHealthStore(options = {}) {
  const paths = resolvePrivateFixturePath(options.filePath, options.runtimeRoot);
  const store = validateStoreApi(options.store || secureJsonStore);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const storeOptions = Object.freeze({
    defaultValue: () => createInitialProviderCircuitState({ now: now() }),
    validator: validateProviderCircuitState,
    mode: 0o600,
    directoryMode: 0o700
  });

  async function read() {
    await assertProviderStoreRealPathBoundary(paths.target, paths.root);
    return store.readJsonFile(paths.target, storeOptions);
  }

  async function transition(expectedWorkflowRevision, transitionFunction) {
    const expected = validateExpectedRevision(expectedWorkflowRevision);
    if (typeof transitionFunction !== "function") {
      throw new TypeError("NAVER provider health transition requires a function");
    }
    return withProviderStoreLock(paths.target, () => store.updateJsonFile(paths.target, async (current) => {
      if (current.workflowRevision !== expected) {
        throw revisionConflict(expected, current.workflowRevision);
      }
      const next = await transitionFunction(current);
      if (!validateProviderCircuitState(next)) {
        const error = new Error("NAVER provider health transition produced an invalid state");
        error.code = "NAVER_PROVIDER_STATE_INVALID";
        throw error;
      }
      if (next.workflowRevision !== current.workflowRevision + 1) {
        const error = new Error("NAVER provider health workflow revision must increase by one");
        error.code = "NAVER_PROVIDER_REVISION_INVALID";
        throw error;
      }
      return next;
    }, storeOptions), paths.root);
  }

  async function beginAttempt(input = {}) {
    const expected = validateExpectedRevision(input.expectedWorkflowRevision);
    let decision = null;
    const state = await withProviderStoreLock(paths.target, () => store.updateJsonFile(paths.target, (current) => {
      if (current.workflowRevision !== expected) {
        throw revisionConflict(expected, current.workflowRevision);
      }
      decision = beginProviderAttempt(current, {
        expectedWorkflowRevision: expected,
        explicit: input.explicit === true,
        now: input.now ?? now()
      });
      return decision.allowed ? decision.state : secureJsonStore.NO_JSON_WRITE;
    }, storeOptions), paths.root);
    return Object.freeze({ ...decision, state });
  }

  async function recordBlock(input = {}) {
    const expected = validateExpectedRevision(input.expectedWorkflowRevision);
    return transition(expected, (current) => recordProviderBlock(current, input.failure, {
      expectedWorkflowRevision: expected,
      now: input.now ?? now()
    }));
  }

  async function refreshAttempt(input = {}) {
    const expected = validateExpectedRevision(input.expectedWorkflowRevision);
    return transition(expected, (current) => refreshProviderAttemptLease(current, {
      expectedWorkflowRevision: expected,
      now: input.now ?? now()
    }));
  }

  async function recordSuccess(input = {}) {
    const expected = validateExpectedRevision(input.expectedWorkflowRevision);
    return transition(expected, (current) => recordProviderSuccess(current, {
      expectedWorkflowRevision: expected,
      now: input.now ?? now()
    }));
  }

  async function releaseAttempt(input = {}) {
    const expected = validateExpectedRevision(input.expectedWorkflowRevision);
    const current = await read();
    if (current.workflowRevision !== expected) throw revisionConflict(expected, current.workflowRevision);
    if (current.state !== "probe_allowed") return current;
    return transition(expected, (value) => releaseProviderAttempt(value, {
      expectedWorkflowRevision: expected,
      now: input.now ?? now()
    }));
  }

  return Object.freeze({
    beginAttempt,
    filePath: paths.target,
    read,
    refreshAttempt,
    recordBlock,
    recordSuccess,
    releaseAttempt,
    runtimeRoot: paths.root,
    transition
  });
}

module.exports = {
  acquireProviderStoreLock,
  assertProviderStoreRealPathBoundary,
  createNaverProviderHealthStore,
  resolvePrivateFixturePath
};
