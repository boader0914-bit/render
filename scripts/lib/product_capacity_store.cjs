"use strict";
// Optional, small derived witness files. Raw collections, company reviews and
// published reports are never written here. A broken cache is not a zero.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { compactProductCapacityEvidence } = require("./product_capacity_baseline.cjs");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = value => [value.size, value.mtimeNs, value.ctimeNs, value.ino, value.dev].map(String).join(":");
const fault = code => Object.assign(new Error(code), { code });
const need = (condition, code = "PRODUCT_CAPACITY_CACHE_INVALID") => { if (!condition) throw fault(code); };
function correctionSignature(company) {
  const correction = company?.manualCorrection;
  if (!correction || correction.active === false || correction.source === "integrated_observed_basis") return hash(null);
  return hash([correction.lodgingBasisTotal || null, correction.roomSegments || [], correction.productStockCorrections || []]);
}
function createProductCapacityStore({ dataDir, outputsDir = path.join(dataDir, "outputs"), maxBytes = 2 * 1024 * 1024, maxEvidence = 10000 } = {}) {
  if (!dataDir) throw new TypeError("A product witness data directory is required");
  const directory = path.join(path.resolve(dataDir), "company_integrated", "product_capacity_witnesses"), root = path.resolve(outputsDir);
  let serial = Promise.resolve();
  const filename = id => path.join(directory, hash(String(id)) + ".json");
  async function descriptor(runId) {
    need(/^[A-Za-z0-9_-]{1,160}$/.test(runId), "PRODUCT_CAPACITY_SOURCE_INVALID");
    const runDirectory = path.join(root, runId), files = [];
    async function visit(current, relative = "", depth = 0) {
      need(depth <= 8, "PRODUCT_CAPACITY_SOURCE_INVALID");
      const stat = await fs.lstat(current, { bigint: true }); need(stat.isDirectory() && !stat.isSymbolicLink(), "PRODUCT_CAPACITY_SOURCE_INVALID");
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.name.endsWith(".tmp")) continue;
        const file = path.join(current, entry.name), name = relative ? relative + "/" + entry.name : entry.name;
        need(!entry.isSymbolicLink(), "PRODUCT_CAPACITY_SOURCE_INVALID");
        if (entry.isDirectory()) await visit(file, name, depth + 1);
        else if (entry.isFile() && /\.(json|csv)$/i.test(entry.name)) {
          const value = await fs.lstat(file, { bigint: true }); need(value.isFile() && !value.isSymbolicLink(), "PRODUCT_CAPACITY_SOURCE_INVALID");
          files.push([name, stamp(value)]); need(files.length <= 2000, "PRODUCT_CAPACITY_SOURCE_INVALID");
        }
      }
    }
    await visit(runDirectory); files.sort((a, b) => a[0].localeCompare(b[0]));
    need(files.some(([name]) => name === "manifest.json"), "PRODUCT_CAPACITY_SOURCE_INVALID");
    return hash(files);
  }
  async function read(company, descriptors = new Map()) {
    let cacheFound = false;
    try {
      const file = filename(company.companyId), before = await fs.lstat(file, { bigint: true });
      cacheFound = true;
      need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes));
      const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
      need(stamp(before) === stamp(after));
      const value = JSON.parse(bytes), { checksum, ...body } = value;
      need(body.schemaVersion === 1 && body.companyId === company.companyId && body.correctionSignature === correctionSignature(company)
        && checksum === hash(body) && typeof body.sourceRevision === "string" && body.sourceRevision
        && Array.isArray(body.evidence) && body.evidence.length <= maxEvidence && Array.isArray(body.runs));
      need(body.evidence.every(row => row.companyId === company.companyId && /^[A-Za-z0-9_-]{1,160}$/.test(row.productId || "")
        && Number.isSafeInteger(row.count) && row.count > 0 && ["lodging", "dayuse"].includes(row.productType)
        && Number.isFinite(Date.parse(row.collectedAt)) && body.runs.some(run => run.id === row.runId)));
      for (const run of body.runs) {
        if (!descriptors.has(run.id)) descriptors.set(run.id, descriptor(run.id));
        need(await descriptors.get(run.id) === run.descriptor, "PRODUCT_CAPACITY_SOURCE_CHANGED");
      }
      return { evidence: body.evidence, warning: null };
    } catch (error) {
      return { evidence: [], warning: error.code === "ENOENT" && !cacheFound ? null : { code: error.code === "ENOENT" ? "PRODUCT_CAPACITY_SOURCE_UNAVAILABLE" : error.code || "PRODUCT_CAPACITY_CACHE_INVALID",
        message: "저장된 상품별 최대관측 근거를 재검증하지 못해 이번 원본 응답으로 계산했습니다." } };
    }
  }
  async function publishOwned(evidence, { companies, sourceRevision, assertCurrent } = {}) {
    need(companies instanceof Map && typeof sourceRevision === "string" && sourceRevision && typeof assertCurrent === "function");
    const groups = new Map(), descriptors = new Map();
    for (const row of compactProductCapacityEvidence(evidence)) {
      need(companies.has(row.companyId));
      if (!groups.has(row.companyId)) groups.set(row.companyId, []);
      groups.get(row.companyId).push(row);
    }
    const pending = [];
    for (const [id, incoming] of groups) {
      // Reading an older month must not erase a later normal maximum. Only a
      // currently verified store under the same DB correction may be merged;
      // corruption, changed raw sources and changed reviews rebuild from the
      // newly validated evidence instead.
      const previous = await read(companies.get(id), descriptors);
      const rows = compactProductCapacityEvidence([...previous.evidence, ...incoming]);
      need(rows.length <= maxEvidence);
      const runs = [];
      for (const runId of [...new Set(rows.map(row => row.runId))].sort()) {
        if (!descriptors.has(runId)) descriptors.set(runId, descriptor(runId));
        runs.push({ id: runId, descriptor: await descriptors.get(runId) });
      }
      const body = { schemaVersion: 1, companyId: id, sourceRevision, correctionSignature: correctionSignature(companies.get(id)), evidence: rows, runs };
      const encoded = JSON.stringify({ ...body, checksum: hash(body) }); need(Buffer.byteLength(encoded) <= maxBytes);
      pending.push({ file: filename(id), encoded });
    }
    await assertCurrent();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const location of [path.dirname(directory), directory]) { const stat = await fs.lstat(location); need(stat.isDirectory() && !stat.isSymbolicLink()); }
    for (const { file, encoded } of pending) {
      const temporary = file + "." + crypto.randomUUID() + ".tmp"; let handle;
      try {
        handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
        await assertCurrent(); await fs.rename(temporary, file);
      } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    }
    return { companies: pending.length };
  }
  return { read, publish(evidence, context) {
    const task = serial.then(() => publishOwned(evidence, context));
    serial = task.then(() => undefined, () => undefined); return task;
  }, directory };
}
module.exports = { createProductCapacityStore, productCapacityCorrectionSignature: correctionSignature };
