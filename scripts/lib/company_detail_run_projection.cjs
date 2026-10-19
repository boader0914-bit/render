"use strict";

// A disposable selected-company/run projection. Authoritative run files are
// never written. Every hit receives a fresh source-identity check; there is no
// TTL or persistent in-memory copy of CSV/product payloads.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = "company-detail-run-projection-v1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(":");
const fault = (code = "COMPANY_DETAIL_RUN_PROJECTION_UNAVAILABLE") => Object.assign(new Error("업체의 회차별 상세 자료를 확인하지 못했습니다. 잠시 후 다시 조회해 주세요."), { code, statusCode: 503 });
const need = (value, code) => { if (!value) throw fault(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);

function createCompanyDetailRunProjectionStore({ dataDir, outputsDir, projectionVersion = VERSION, fileSystem = fs,
  executeBuild = (action) => action(), maxCacheBytes = 16 * 1024 * 1024 } = {}) {
  const root = path.resolve(dataDir), outputs = path.resolve(outputsDir || path.join(root, "outputs"));
  const cacheDir = path.join(root, "company_master", "detail_run_projections");
  let buildTail = Promise.resolve();
  function serialBuild(action) {
    const pending = buildTail.then(action, action);
    // Retain only a void completion promise, not a large previous projection.
    buildTail = pending.then(() => {}, () => {}); return pending;
  }
  async function directory(filename) { const value = await fileSystem.lstat(filename, { bigint: true }); need(value.isDirectory() && !value.isSymbolicLink()); return value; }
  async function source(runId) {
    const run = path.resolve(outputs, runId); need(run.startsWith(outputs + path.sep), "COMPANY_DETAIL_RUN_ID_INVALID");
    await directory(outputs); const entries = []; let files = 0, bytes = 0;
    async function visit(filename, relative, depth) {
      need(depth <= 8 && files <= 20000, "COMPANY_DETAIL_RUN_SCAN_LIMIT");
      const before = await directory(filename); entries.push([relative + "/", stamp(before)]);
      const children = (await fileSystem.readdir(filename, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      // Sequential metadata reads keep one run's scan bounded even when several
      // independent detail requests have different company/run keys.
      for (const entry of children) {
        need(!entry.isSymbolicLink() && ++files <= 20000, "COMPANY_DETAIL_RUN_SCAN_LIMIT");
        const nested = path.join(filename, entry.name), label = relative + "/" + entry.name;
        if (entry.isDirectory()) await visit(nested, label, depth + 1);
        else {
          const value = await fileSystem.lstat(nested, { bigint: true });
          need(entry.isFile() && value.isFile() && !value.isSymbolicLink()); entries.push([label, stamp(value)]); bytes += Number(value.size);
        }
      }
      need(stamp(await directory(filename)) === stamp(before), "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
    }
    try { await visit(run, runId, 0); }
    catch (error) { throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_RUN_SOURCE_UNAVAILABLE"); }
    return { revision: hash(entries), bytes, files };
  }
  async function safeCacheDirectory() {
    await directory(root);
    try { await directory(path.dirname(cacheDir)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await fileSystem.mkdir(path.dirname(cacheDir), { mode: 0o700 }); } catch (created) { if (created.code !== "EEXIST") throw created; }
      await directory(path.dirname(cacheDir));
    }
    await fileSystem.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await directory(cacheDir);
  }
  async function read(file) {
    try {
      const before = await fileSystem.lstat(file, { bigint: true });
      need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxCacheBytes), "COMPANY_DETAIL_RUN_CACHE_INVALID");
      const text = await fileSystem.readFile(file, "utf8");
      need(stamp(await fileSystem.lstat(file, { bigint: true })) === stamp(before), "COMPANY_DETAIL_RUN_CACHE_INVALID");
      return JSON.parse(text);
    } catch (error) { if (error.code === "ENOENT") return null; throw fault("COMPANY_DETAIL_RUN_CACHE_INVALID"); }
  }
  function valid(value, companyId, runId, companyRevision) {
    return object(value) && value.version === VERSION && value.projectionVersion === projectionVersion
      && value.companyId === companyId && value.runId === runId && value.companyRevision === companyRevision
      && object(value.data?.run) && Array.isArray(value.data?.availability?.items)
      && value.checksum === hash({ ...value, checksum: undefined });
  }
  async function load({ company, runId, build }) {
    const companyId = String(company.companyId), companyRevision = hash(company);
    const filename = path.join(cacheDir, hash([companyId, runId]) + ".json"), before = await source(runId);
    await safeCacheDirectory();
    let saved = await read(filename);
    if (valid(saved, companyId, runId, companyRevision) && saved.source === before.revision) {
      need((await source(runId)).revision === before.revision && hash(company) === companyRevision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
      return { data: saved.data, cacheStatus: "saved", preparedAt: saved.preparedAt, sourceBytes: before.bytes };
    }
    saved = null;
    // Global admission must precede our local build queue. Otherwise an outside
    // miss can own the local tail while waiting for a heavy owner which itself
    // needs a run projection, producing a global/local lock inversion.
    return executeBuild(() => serialBuild(async () => {
      need((await source(runId)).revision === before.revision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
      // A preceding admitted miss may have published this exact projection.
      // Recheck inside the serialized section instead of joining a promise
      // which could itself be waiting for the current global heavy owner.
      let reopened = await read(filename);
      if (valid(reopened, companyId, runId, companyRevision) && reopened.source === before.revision) {
        need((await source(runId)).revision === before.revision && hash(company) === companyRevision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
        return { data: reopened.data, cacheStatus: "saved", preparedAt: reopened.preparedAt, sourceBytes: before.bytes };
      }
      reopened = null;
      let data;
      try { data = await build(); }
      catch (error) { throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_RUN_BUILD_FAILED"); }
      need(object(data?.run) && Array.isArray(data?.availability?.items), "COMPANY_DETAIL_RUN_BUILD_INCOMPLETE");
      need(hash(company) === companyRevision && (await source(runId)).revision === before.revision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
      const body = { version: VERSION, projectionVersion, companyId, runId, companyRevision, source: before.revision,
        preparedAt: new Date().toISOString(), data }, next = { ...body, checksum: hash(body) };
      const text = JSON.stringify(next); need(Buffer.byteLength(text) <= maxCacheBytes, "COMPANY_DETAIL_RUN_CACHE_LIMIT");
      const temporary = filename + "." + process.pid + "." + crypto.randomBytes(8).toString("hex") + ".tmp", backup = temporary + ".previous";
      let backedUp = false, published = false;
      try {
        await fileSystem.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        try { await fileSystem.link(filename, backup); backedUp = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
        need((await source(runId)).revision === before.revision && hash(company) === companyRevision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
        await fileSystem.rename(temporary, filename); published = true;
        need((await source(runId)).revision === before.revision && hash(company) === companyRevision, "COMPANY_DETAIL_RUN_SOURCE_CHANGED");
      } catch (error) {
        if (published) {
          try {
            const current = await read(filename);
            if (current?.checksum === next.checksum) {
              if (backedUp) { await fileSystem.rename(backup, filename); backedUp = false; } else await fileSystem.unlink(filename);
            }
          } catch { throw fault("COMPANY_DETAIL_RUN_CACHE_ROLLBACK_FAILED"); }
        }
        await fileSystem.unlink(temporary).catch(() => {}); if (backedUp) await fileSystem.unlink(backup).catch(() => {});
        throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_RUN_CACHE_WRITE_FAILED");
      }
      if (backedUp) await fileSystem.unlink(backup).catch(() => {});
      return { data, cacheStatus: "calculated", preparedAt: next.preparedAt, sourceBytes: before.bytes };
    }), { runId, companyId, sourceBytes: before.bytes, sourceFiles: before.files });
  }
  return { async get(input) {
    const runId = String(input.runId || ""), company = input.company;
    need(runId && runId !== "." && runId !== ".." && path.basename(runId) === runId && !/[\\/\x00-\x1f]/.test(runId), "COMPANY_DETAIL_RUN_ID_INVALID");
    need(object(company) && typeof company.companyId === "string" && company.companyId && typeof input.build === "function", "COMPANY_DETAIL_RUN_COMPANY_INVALID");
    return load({ ...input, runId });
  } };
}

module.exports = { createCompanyDetailRunProjectionStore, VERSION };
