"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { AUTH_SCHEMA_VERSION } = require("../contracts/auth.cjs");
const { opaqueId } = require("../services/auth_crypto.cjs");

const AUTH_STORE_KIND = "glamping-datalab-v2-integration-auth";
const FORBIDDEN_AUTH_STORE_BASENAMES = Object.freeze(new Set([
  "b2b_members.json",
  "b2b_session.json",
  "sessions.json",
  "members.json",
  "users.json"
]));

function iso(clock) {
  return new Date(clock()).toISOString();
}

function emptyAuthStore(clock = Date.now) {
  const now = iso(clock);
  return {
    storeKind: AUTH_STORE_KIND,
    schemaVersion: AUTH_SCHEMA_VERSION,
    storeId: opaqueId("authstore"),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    security: {
      bootstrapCompletedAt: "",
      bootstrapAccountId: ""
    },
    accounts: [],
    companies: [],
    memberships: [],
    sessions: [],
    invites: [],
    passwordResets: [],
    mfaFactors: [],
    authChallenges: [],
    loginGuards: [],
    authAudit: [],
    emailOutbox: []
  };
}

function clone(value) {
  return structuredClone(value);
}

function assertAuthStoreShape(store) {
  if (!store || store.storeKind !== AUTH_STORE_KIND) {
    throw new Error("Configured auth store is not a Stage 226 integration auth store");
  }
  if (store.schemaVersion !== AUTH_SCHEMA_VERSION) {
    throw new Error(`Unsupported auth store schema version: ${store.schemaVersion}`);
  }
  for (const field of [
    "accounts",
    "companies",
    "memberships",
    "sessions",
    "invites",
    "passwordResets",
    "mfaFactors",
    "authChallenges",
    "loginGuards",
    "authAudit",
    "emailOutbox"
  ]) {
    if (!Array.isArray(store[field])) throw new Error(`Auth store field ${field} must be an array`);
  }
  if (!store.security || typeof store.security !== "object") throw new Error("Auth store security metadata is required");
  return store;
}

function resolveAuthStorePath(filePath) {
  const configured = String(filePath || "").trim();
  if (!configured) throw new Error("V2_INTEGRATION_AUTH_STORE_PATH is required when integration auth is enabled");
  const resolved = path.resolve(configured);
  const basename = path.basename(resolved).toLowerCase();
  if (FORBIDDEN_AUTH_STORE_BASENAMES.has(basename)) {
    throw new Error(`Refusing legacy or ambiguous auth store path: ${basename}`);
  }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  if (/\/(config|customer_db)\/b2b_/.test(normalized) || /\/test\/fixtures\/stage22[123]\//.test(normalized)) {
    throw new Error("Refusing an existing V2/Cluster auth data or contract-fixture path");
  }
  return resolved;
}

function createAuthRepository(options = {}) {
  const clock = options.clock || Date.now;
  const filePath = resolveAuthStorePath(options.filePath);
  let current = null;
  let queue = Promise.resolve();

  async function withFileLock(work) {
    const lockPath = `${filePath}.lock`;
    const deadline = Date.now() + 5000;
    let handle;
    while (!handle) {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.unlink(lockPath).catch(() => undefined);
    }
  }

  async function writeAtomic(store) {
    assertAuthStoreShape(store);
    return withFileLock(async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
        await fsp.rename(tempPath, filePath);
        await fsp.chmod(filePath, 0o600).catch(() => undefined);
      } catch (error) {
        await fsp.unlink(tempPath).catch(() => undefined);
        throw error;
      }
    });
  }

  async function initialize() {
    if (current) return clone(current);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
      current = assertAuthStoreShape(parsed);
      return clone(current);
    }
    current = emptyAuthStore(clock);
    await writeAtomic(current);
    return clone(current);
  }

  function snapshot() {
    if (!current) throw new Error("Auth repository has not been initialized");
    return clone(current);
  }

  function currentUnsafe() {
    if (!current) throw new Error("Auth repository has not been initialized");
    return current;
  }

  function transaction(actor, mutate) {
    const run = async () => {
      if (!current) await initialize();
      const next = clone(current);
      const result = await mutate(next);
      next.revision = Number(current.revision || 0) + 1;
      next.updatedAt = iso(clock);
      next.lastActor = String(actor || "system").slice(0, 160);
      assertAuthStoreShape(next);
      await writeAtomic(next);
      current = next;
      return result === undefined ? clone(next) : result;
    };
    const pending = queue.then(run, run);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  return Object.freeze({
    filePath,
    initialize,
    snapshot,
    currentUnsafe,
    transaction
  });
}

module.exports = {
  AUTH_STORE_KIND,
  FORBIDDEN_AUTH_STORE_BASENAMES,
  assertAuthStoreShape,
  createAuthRepository,
  emptyAuthStore,
  resolveAuthStorePath
};
