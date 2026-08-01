const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;
const NO_JSON_WRITE = Symbol("NO_JSON_WRITE");

function createSecureJsonStore(dependencies = {}) {
  const fsApi = dependencies.fs || fsp;
  const randomBytes = dependencies.randomBytes || crypto.randomBytes;
  const queues = new Map();

  function normalizePath(filePath) {
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new TypeError("secure JSON store requires an absolute file path");
    }
    return path.resolve(filePath);
  }

  function validateValue(value, validator, label) {
    if (typeof validator !== "function") return value;
    const result = validator(value);
    if (result === false) throw new Error(`${label} failed validation`);
    return value;
  }

  function defaultValueFor(options = {}) {
    return typeof options.defaultValue === "function"
      ? options.defaultValue()
      : options.defaultValue;
  }

  function readCandidates(filePath, options = {}) {
    const target = normalizePath(filePath);
    const fallbackPaths = Array.isArray(options.fallbackPaths) ? options.fallbackPaths : [];
    return [target, ...fallbackPaths.map((candidate) => normalizePath(candidate))]
      .filter((candidate, index, values) => values.indexOf(candidate) === index);
  }

  async function hardenFilePermissions(filePath, mode = DEFAULT_FILE_MODE) {
    await fsApi.chmod(filePath, mode).catch((error) => {
      if (!["ENOSYS", "ENOTSUP", "EPERM", "EACCES"].includes(error?.code)) throw error;
    });
  }

  async function readJsonFile(filePath, options = {}) {
    const candidates = readCandidates(filePath, options);
    for (const candidate of candidates) {
      try {
        const content = await fsApi.readFile(candidate, "utf8");
        await hardenFilePermissions(candidate, Number.isInteger(options.mode) ? options.mode : DEFAULT_FILE_MODE);
        const parsed = JSON.parse(String(content).replace(/^\uFEFF/, ""));
        const validated = validateValue(parsed, options.validator, candidate);
        return validated;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "defaultValue")) {
      return validateValue(defaultValueFor(options), options.validator, candidates[0]);
    }
    const error = new Error(`secure JSON store file not found: ${candidates[0]}`);
    error.code = "ENOENT";
    throw error;
  }

  function enqueue(filePath, task) {
    const target = normalizePath(filePath);
    const prior = queues.get(target) || Promise.resolve();
    const current = prior.catch(() => {}).then(task);
    queues.set(target, current);
    return current.finally(() => {
      if (queues.get(target) === current) queues.delete(target);
    });
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await fsApi.open(directory, "r");
      await handle.sync();
    } catch {
      // The JSON target has already been committed. Directory fsync is a
      // best-effort durability step and must not report a false write failure.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function atomicWriteJsonUnlocked(filePath, value, options = {}) {
    const target = normalizePath(filePath);
    const directory = path.dirname(target);
    const mode = Number.isInteger(options.mode) ? options.mode : DEFAULT_FILE_MODE;
    const directoryMode = Number.isInteger(options.directoryMode)
      ? options.directoryMode
      : DEFAULT_DIRECTORY_MODE;
    const serialized = `${JSON.stringify(value, null, options.space ?? 2)}\n`;
    const parsedBeforeWrite = JSON.parse(serialized);
    validateValue(parsedBeforeWrite, options.validator, target);

    await fsApi.mkdir(directory, { recursive: true, mode: directoryMode });
    const unique = randomBytes(12).toString("hex");
    const tempPath = path.join(directory, `.${path.basename(target)}.${process.pid}.${unique}.tmp`);
    let handle;

    try {
      handle = await fsApi.open(tempPath, "wx", mode);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await hardenFilePermissions(tempPath, mode);

      const persisted = JSON.parse((await fsApi.readFile(tempPath, "utf8")).replace(/^\uFEFF/, ""));
      validateValue(persisted, options.validator, tempPath);
      await fsApi.rename(tempPath, target);
      await syncDirectory(directory);
      return persisted;
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsApi.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function atomicWriteJson(filePath, value, options = {}) {
    return enqueue(filePath, () => atomicWriteJsonUnlocked(filePath, value, options));
  }

  async function updateJsonFile(filePath, updater, options = {}) {
    if (typeof updater !== "function") throw new TypeError("secure JSON update requires an updater function");
    return enqueue(filePath, async () => {
      const current = await readJsonFile(filePath, options);
      const updated = await updater(current);
      if (updated === NO_JSON_WRITE) return current;
      const next = updated === undefined ? current : updated;
      return atomicWriteJsonUnlocked(filePath, next, options);
    });
  }

  return {
    atomicWriteJson,
    readJsonFile,
    updateJsonFile
  };
}

const defaultStore = createSecureJsonStore();

module.exports = {
  DEFAULT_DIRECTORY_MODE,
  DEFAULT_FILE_MODE,
  NO_JSON_WRITE,
  atomicWriteJson: defaultStore.atomicWriteJson,
  createSecureJsonStore,
  readJsonFile: defaultStore.readJsonFile,
  updateJsonFile: defaultStore.updateJsonFile
};
