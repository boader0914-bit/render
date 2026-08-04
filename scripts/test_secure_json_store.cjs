const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  NO_JSON_WRITE,
  atomicWriteJson,
  createSecureJsonStore,
  readJsonFile,
  updateJsonFile
} = require("./secure_json_store.cjs");

function validateCounterStore(value) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true);
  assert.equal(Number.isInteger(value.counter) && value.counter >= 0, true);
  assert.equal(Array.isArray(value.events), true);
  return true;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function tempFiles(directory) {
  return (await fsp.readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "secure-json-store-"));
  const target = path.join(tempRoot, "customer_db", "members.json");
  const validator = validateCounterStore;
  try {
    await assert.rejects(
      () => atomicWriteJson("relative.json", { counter: 0, events: [] }),
      /absolute file path/
    );

    const initial = {
      schemaVersion: 1,
      counter: 0,
      events: [],
      unknownFutureField: { keep: true }
    };
    await atomicWriteJson(target, initial, { validator });
    assert.deepEqual(await readJsonFile(target, { validator }), initial);

    if (process.platform !== "win32") {
      const permissions = (await fsp.stat(target)).mode & 0o777;
      assert.equal(permissions, 0o600, "private JSON files must be owner-readable and owner-writable only");
      const directoryPermissions = (await fsp.stat(path.dirname(target))).mode & 0o777;
      assert.equal(directoryPermissions, 0o700, "new private storage directories must be owner-only");

      const legacyPermissionsTarget = path.join(tempRoot, "customer_db", "legacy-permissions.json");
      await fsp.writeFile(legacyPermissionsTarget, JSON.stringify(initial), { mode: 0o644 });
      await fsp.chmod(legacyPermissionsTarget, 0o644);
      await readJsonFile(legacyPermissionsTarget, { validator });
      assert.equal(
        (await fsp.stat(legacyPermissionsTarget)).mode & 0o777,
        0o600,
        "reading an existing private JSON file must harden legacy permissions"
      );
    }

    await Promise.all(Array.from({ length: 40 }, (_, index) => updateJsonFile(target, async (store) => {
      await new Promise((resolve) => setTimeout(resolve, index % 4));
      store.counter += 1;
      store.events.push(`event-${index}`);
      return store;
    }, { validator })));

    const concurrent = await readJsonFile(target, { validator });
    assert.equal(concurrent.counter, 40, "per-file queue must not lose concurrent increments");
    assert.equal(new Set(concurrent.events).size, 40, "per-file queue must preserve every concurrent event");
    assert.deepEqual(concurrent.unknownFutureField, { keep: true }, "unknown existing fields must survive updates");
    assert.deepEqual(await tempFiles(path.dirname(target)), [], "successful writes must not leave temporary files");

    const originalContent = await fsp.readFile(target, "utf8");
    const originalHash = hash(originalContent);
    const openFailureFs = {
      ...fsp,
      async open(filePath, flags, mode) {
        if (String(filePath).endsWith(".tmp")) {
          const error = new Error("injected temp open failure");
          error.code = "EACCES";
          throw error;
        }
        return fsp.open(filePath, flags, mode);
      }
    };
    const openFailureStore = createSecureJsonStore({ fs: openFailureFs });
    await assert.rejects(
      () => openFailureStore.atomicWriteJson(target, { ...concurrent, counter: 41 }, { validator }),
      /injected temp open failure/
    );
    assert.equal(hash(await fsp.readFile(target, "utf8")), originalHash, "temp creation failure must preserve the original");

    let capturedTempPath = "";
    const renameFailureFs = {
      ...fsp,
      async open(filePath, flags, mode) {
        if (String(filePath).endsWith(".tmp")) capturedTempPath = String(filePath);
        return fsp.open(filePath, flags, mode);
      },
      async rename() {
        const error = new Error("injected rename failure");
        error.code = "EIO";
        throw error;
      }
    };
    const renameFailureStore = createSecureJsonStore({ fs: renameFailureFs });
    await assert.rejects(
      () => renameFailureStore.atomicWriteJson(target, { ...concurrent, counter: 41 }, { validator }),
      /injected rename failure/
    );
    assert.equal(path.dirname(capturedTempPath), path.dirname(target), "temporary files must stay beside the target");
    assert.notEqual(capturedTempPath, target, "temporary and target paths must differ");
    assert.equal(hash(await fsp.readFile(target, "utf8")), originalHash, "rename failure must preserve the original");
    assert.deepEqual(await tempFiles(path.dirname(target)), [], "failed writes must remove temporary files");

    const chmodFailureTarget = path.join(tempRoot, "customer_db", "chmod-failure.json");
    await atomicWriteJson(chmodFailureTarget, initial, { validator });
    const chmodFailureHash = hash(await fsp.readFile(chmodFailureTarget, "utf8"));
    const chmodFailureFs = {
      ...fsp,
      async chmod(filePath, mode) {
        if (String(filePath).endsWith(".tmp")) {
          const error = new Error("injected temp chmod failure");
          error.code = "EIO";
          throw error;
        }
        return fsp.chmod(filePath, mode);
      }
    };
    const chmodFailureStore = createSecureJsonStore({ fs: chmodFailureFs });
    await assert.rejects(
      () => chmodFailureStore.atomicWriteJson(chmodFailureTarget, { ...initial, counter: 1 }, { validator }),
      /injected temp chmod failure/
    );
    assert.equal(
      hash(await fsp.readFile(chmodFailureTarget, "utf8")),
      chmodFailureHash,
      "permission hardening failure before rename must preserve the original"
    );
    assert.deepEqual(await tempFiles(path.dirname(chmodFailureTarget)), [], "chmod failure must remove temporary files");

    const directorySyncTarget = path.join(tempRoot, "customer_db", "directory-sync.json");
    await atomicWriteJson(directorySyncTarget, initial, { validator });
    const directorySyncFs = {
      ...fsp,
      async open(filePath, flags, mode) {
        if (path.resolve(String(filePath)) === path.resolve(path.dirname(directorySyncTarget)) && flags === "r") {
          return {
            async sync() {
              const error = new Error("injected directory sync failure");
              error.code = "EIO";
              throw error;
            },
            async close() {}
          };
        }
        return fsp.open(filePath, flags, mode);
      }
    };
    const directorySyncStore = createSecureJsonStore({ fs: directorySyncFs });
    await directorySyncStore.atomicWriteJson(directorySyncTarget, { ...initial, counter: 1 }, { validator });
    assert.equal(
      (await readJsonFile(directorySyncTarget, { validator })).counter,
      1,
      "a best-effort directory fsync failure after rename must not report a false write failure"
    );

    const noReplaceCleanupTarget = path.join(tempRoot, "customer_db", "no-replace-cleanup.json");
    let linkedTempPath = "";
    const noReplaceCleanupFs = {
      ...fsp,
      async link(tempPath, targetPath) {
        linkedTempPath = String(tempPath);
        return fsp.link(tempPath, targetPath);
      },
      async rm(filePath, options) {
        if (String(filePath) === linkedTempPath) {
          const error = new Error("injected post-link temp cleanup failure");
          error.code = "EIO";
          throw error;
        }
        return fsp.rm(filePath, options);
      }
    };
    const noReplaceCleanupStore = createSecureJsonStore({ fs: noReplaceCleanupFs });
    await noReplaceCleanupStore.atomicWriteJson(noReplaceCleanupTarget, initial, { validator, noReplace: true });
    assert.deepEqual(
      await readJsonFile(noReplaceCleanupTarget, { validator }),
      initial,
      "post-link temp cleanup failure must not report a false no-replace commit failure"
    );

    const noReplaceChmodTarget = path.join(tempRoot, "customer_db", "no-replace-target-chmod.json");
    const noReplaceChmodFs = {
      ...fsp,
      async chmod(filePath, mode) {
        if (path.resolve(String(filePath)) === path.resolve(noReplaceChmodTarget)) {
          const error = new Error("injected post-link target chmod failure");
          error.code = "EIO";
          throw error;
        }
        return fsp.chmod(filePath, mode);
      }
    };
    const noReplaceChmodStore = createSecureJsonStore({ fs: noReplaceChmodFs });
    await noReplaceChmodStore.atomicWriteJson(noReplaceChmodTarget, initial, { validator, noReplace: true });
    assert.deepEqual(
      await readJsonFile(noReplaceChmodTarget, { validator }),
      initial,
      "no-replace commit must not perform a failure-prone chmod after the hard-link commit point"
    );

    await assert.rejects(
      () => atomicWriteJson(target, { counter: -1, events: [] }, { validator }),
      /AssertionError|failed validation/
    );
    assert.equal(hash(await fsp.readFile(target, "utf8")), originalHash, "validation failure must preserve the original");
    const recovered = await updateJsonFile(target, (store) => ({ ...store, recoveredAfterFailure: true }), { validator });
    assert.equal(recovered.recoveredAfterFailure, true, "a failed queued write must not poison later updates");

    const beforeNoWrite = await fsp.readFile(target, "utf8");
    const skipped = await updateJsonFile(target, () => NO_JSON_WRITE, { validator });
    assert.equal(skipped.counter, concurrent.counter, "no-write updates return the current validated value");
    assert.equal(await fsp.readFile(target, "utf8"), beforeNoWrite, "no-write updates do not rotate the persisted file");

    const legacy = path.join(tempRoot, "legacy", "members.json");
    const migrated = path.join(tempRoot, "customer_db", "migrated-members.json");
    await atomicWriteJson(legacy, initial, { validator });
    assert.deepEqual(
      await readJsonFile(migrated, { fallbackPaths: [legacy], validator }),
      initial,
      "legacy fallback remains readable when the primary path has not been migrated"
    );
    await updateJsonFile(migrated, (store) => ({ ...store, counter: store.counter + 1 }), {
      fallbackPaths: [legacy],
      validator
    });
    assert.equal((await readJsonFile(migrated, { validator })).counter, 1, "the first update migrates legacy content atomically");
    assert.equal((await readJsonFile(legacy, { validator })).counter, 0, "legacy source is never rewritten");

    const absent = path.join(tempRoot, "customer_db", "absent.json");
    const defaulted = await readJsonFile(absent, {
      defaultValue: () => ({ counter: 0, events: [], marker: crypto.randomUUID() }),
      validator
    });
    assert.equal(defaulted.counter, 0);
    await assert.rejects(() => readJsonFile(absent), { code: "ENOENT" });

    console.log("Secure atomic JSON storage checks passed");
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected temp path: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
