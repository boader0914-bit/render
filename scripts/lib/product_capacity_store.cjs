"use strict";
// Optional, small derived witness files. Raw collections, company reviews and
// published reports are never written here. A broken cache is not a zero.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { compactProductCapacityEvidence } = require("./product_capacity_baseline.cjs");
const { runNonInterruptibleCooperativeWork, setCooperativeWorkPhase } = require("./cooperative_work_checkpoint.cjs");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = value => [value.size, value.mtimeNs, value.ctimeNs, value.ino, value.dev].map(String).join(":");
const fault = code => Object.assign(new Error(code), { code });
const need = (condition, code = "PRODUCT_CAPACITY_CACHE_INVALID") => { if (!condition) throw fault(code); };
function correctionSignature(company) {
  const correction = company?.manualCorrection;
  if (!correction || correction.active === false || correction.source === "integrated_observed_basis") return hash(null);
  return hash([correction.lodgingBasisTotal || null, correction.roomSegments || [], correction.productStockCorrections || []]);
}
function createProductCapacityStore({ dataDir, outputsDir = path.join(dataDir, "outputs"), maxBytes = 2 * 1024 * 1024, maxEvidence = 10000, maxVerificationDescriptors = 2048 } = {}) {
  if (!dataDir) throw new TypeError("A product witness data directory is required");
  if (!Number.isSafeInteger(maxVerificationDescriptors) || maxVerificationDescriptors < 1 || maxVerificationDescriptors > 4096) throw new TypeError("Product witness descriptor limit must be between 1 and 4096");
  const directory = path.join(path.resolve(dataDir), "company_integrated", "product_capacity_witnesses"), root = path.resolve(outputsDir);
  const verificationScopes = new AsyncLocalStorage();
  const metrics = { descriptorScans: 0, descriptorProofHits: 0, descriptorProofEvictions: 0, maximumVerificationDescriptors: 0, verificationChecks: 0, witnessReads: 0, activeVerificationScopes: 0, retainedVerificationDescriptors: 0 };
  let serial = Promise.resolve();
  const filename = id => path.join(directory, hash(String(id)) + ".json");
  const activeProof = () => { const proof = verificationScopes.getStore(); return proof?.active ? proof : null; };
  async function assertProofCurrent(proof) { if (!proof || !proof.active || activeProof() !== proof) return; metrics.verificationChecks++; await proof.assertCurrent(); }
  async function freshProof() { const proof = activeProof(); if (proof) await assertProofCurrent(proof); return proof; }
  async function withDescriptorVerificationScope({ sourceRevision, assertCurrent } = {}, operation) {
    // Explicit internal opt-in: assertCurrent must freshly compare the entire
    // original-run inventory/correction revision captured by sourceRevision.
    // A witness's sourceRevision may include a catalog calculation signature;
    // do not confuse that provenance field with this whole-source boundary.
    if (typeof sourceRevision !== "string" || !sourceRevision || sourceRevision.length > 1024 || typeof assertCurrent !== "function" || typeof operation !== "function") throw new TypeError("A current whole-source verification boundary is required");
    const proof = { sourceRevision, assertCurrent, descriptors: new Map(), active: true }; metrics.activeVerificationScopes++;
    return verificationScopes.run(proof, async () => {
      try { const result = await operation(); await assertProofCurrent(proof); return result; }
      finally { proof.active = false; metrics.retainedVerificationDescriptors -= proof.descriptors.size; proof.descriptors.clear(); proof.assertCurrent = null; proof.sourceRevision = null; metrics.activeVerificationScopes--; }
    });
  }
  function rememberDescriptor(proof, runId, value) {
    if (!proof?.active || activeProof() !== proof) return;
    if (proof.descriptors.has(runId)) proof.descriptors.delete(runId); else metrics.retainedVerificationDescriptors++;
    proof.descriptors.set(runId, value);
    while (proof.descriptors.size > maxVerificationDescriptors) { proof.descriptors.delete(proof.descriptors.keys().next().value); metrics.descriptorProofEvictions++; metrics.retainedVerificationDescriptors--; }
    metrics.maximumVerificationDescriptors = Math.max(metrics.maximumVerificationDescriptors, proof.descriptors.size);
  }
  function resolveDescriptor(runId, descriptors, checkpoint, proof = null) {
    if (!descriptors.has(runId)) {
      if (proof?.active && activeProof() === proof && proof.descriptors.has(runId)) {
        const value = proof.descriptors.get(runId); rememberDescriptor(proof, runId, value); metrics.descriptorProofHits++; descriptors.set(runId, value);
      } else descriptors.set(runId, descriptor(runId, checkpoint).then(value => { rememberDescriptor(proof, runId, value); return value; }));
    }
    return descriptors.get(runId);
  }
  async function descriptor(runId, checkpoint = null) {
    need(/^[A-Za-z0-9_-]{1,160}$/.test(runId), "PRODUCT_CAPACITY_SOURCE_INVALID");
    metrics.descriptorScans++;
    const runDirectory = path.join(root, runId), files = [];
    async function visit(current, relative = "", depth = 0) {
      if (checkpoint) await checkpoint();
      need(depth <= 8, "PRODUCT_CAPACITY_SOURCE_INVALID");
      const stat = await fs.lstat(current, { bigint: true }); need(stat.isDirectory() && !stat.isSymbolicLink(), "PRODUCT_CAPACITY_SOURCE_INVALID");
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.name.endsWith(".tmp")) continue;
        if (checkpoint) await checkpoint();
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
  async function readWithSignature(companyId, signature, descriptors = new Map(), { checkpoint = async () => {}, onVerified = null, _descriptorProof = null } = {}) {
    if (typeof checkpoint !== "function") throw new TypeError("Product witness read checkpoint must be a function");
    if (onVerified !== null && typeof onVerified !== "function") throw new TypeError("Product witness verification capture must be a function");
    let cacheFound = false, checkpointFailed = false, checkpointFailure;
    const check = async () => {
      try { await checkpoint(); }
      catch (error) { checkpointFailed = true; checkpointFailure = error; throw error; }
    };
    await check();
    try {
      const file = filename(companyId), before = await fs.lstat(file, { bigint: true });
      metrics.witnessReads++;
      cacheFound = true;
      need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes));
      const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
      need(stamp(before) === stamp(after));
      const value = JSON.parse(bytes), { checksum, ...body } = value;
      need(body.schemaVersion === 1 && body.companyId === companyId && body.correctionSignature === signature
        && checksum === hash(body) && typeof body.sourceRevision === "string" && body.sourceRevision
        && Array.isArray(body.evidence) && body.evidence.length <= maxEvidence && Array.isArray(body.runs));
      need(body.evidence.every(row => row.companyId === companyId && /^[A-Za-z0-9_-]{1,160}$/.test(row.productId || "")
        && Number.isSafeInteger(row.count) && row.count > 0 && ["lodging", "dayuse"].includes(row.productType)
        && Number.isFinite(Date.parse(row.collectedAt)) && body.runs.some(run => run.id === row.runId)));
      for (const run of body.runs) {
        await check();
        need(await resolveDescriptor(run.id, descriptors, check, _descriptorProof) === run.descriptor, "PRODUCT_CAPACITY_SOURCE_CHANGED");
        await check();
      }
      // Internal publication proof only: scope, review, checksum and every
      // original-run descriptor have all passed before an existing body can
      // authorize skipping an identical derived-file replacement.
      if (onVerified) onVerified({ ...body, checksum });
      return { evidence: body.evidence, warning: null };
    } catch (error) {
      // A scheduling interruption is not a corrupt optional witness. Propagate
      // the caller's exact rejection so no partial evidence becomes a normal read.
      if (checkpointFailed) throw checkpointFailure;
      return { evidence: [], warning: error.code === "ENOENT" && !cacheFound ? null : { code: error.code === "ENOENT" ? "PRODUCT_CAPACITY_SOURCE_UNAVAILABLE" : error.code || "PRODUCT_CAPACITY_CACHE_INVALID",
        message: "저장된 상품별 최대관측 근거를 재검증하지 못해 이번 원본 응답으로 계산했습니다." } };
    }
  }
  const read = (company, descriptors = new Map(), options) => readWithSignature(company.companyId, correctionSignature(company), descriptors, options);
  async function readForCompanies(companies, { checkpoint = async () => {} } = {}) {
    if (typeof checkpoint !== "function") throw new TypeError("Product witness read checkpoint must be a function");
    need(Array.isArray(companies));
    const proof = await freshProof(), descriptors = new Map(), evidence = [], warnings = [];
    const seen = new Set();
    for (const company of companies) {
      await checkpoint();
      need(company?.companyId && !seen.has(company.companyId)); seen.add(company.companyId);
      const saved = await read(company, descriptors, { checkpoint, _descriptorProof: proof });
      evidence.push(...saved.evidence);
      if (saved.warning) warnings.push({ companyId: company.companyId, ...saved.warning });
    }
    return { evidence, warnings, revision: hash([compactProductCapacityEvidence(evidence), warnings.map(row => [row.companyId, row.code])]) };
  }
  async function publishOwned(evidence, { companies, sourceRevision, assertCurrent, checkpoint = async () => {} } = {}) {
    if (typeof checkpoint !== "function") throw new TypeError("Product witness publication checkpoint must be a function");
    need(companies instanceof Map && typeof sourceRevision === "string" && sourceRevision && typeof assertCurrent === "function");
    const proof = await freshProof(), groups = new Map(), descriptors = new Map();
    for (const row of compactProductCapacityEvidence(evidence)) {
      need(companies.has(row.companyId));
      if (!groups.has(row.companyId)) groups.set(row.companyId, []);
      groups.get(row.companyId).push(row);
    }
    const pending = []; let preparationIndex = 0;
    for (const [id, incoming] of groups) {
      setCooperativeWorkPhase(70, ++preparationIndex);
      await checkpoint();
      // Reading an older month must not erase a later normal maximum. Only a
      // currently verified store under the same DB correction may be merged;
      // corruption, changed raw sources and changed reviews rebuild from the
      // newly validated evidence instead.
      let verifiedPrevious = null;
      const previous = await read(companies.get(id), descriptors, { checkpoint, _descriptorProof: proof,
        onVerified: value => { verifiedPrevious = JSON.stringify(value); } });
      const rows = compactProductCapacityEvidence([...previous.evidence, ...incoming]);
      need(rows.length <= maxEvidence);
      const runs = [];
      for (const runId of [...new Set(rows.map(row => row.runId))].sort()) {
        await checkpoint();
        runs.push({ id: runId, descriptor: await resolveDescriptor(runId, descriptors, checkpoint, proof) });
      }
      const body = { schemaVersion: 1, companyId: id, sourceRevision, correctionSignature: correctionSignature(companies.get(id)), evidence: rows, runs };
      const encoded = JSON.stringify({ ...body, checksum: hash(body) }); need(Buffer.byteLength(encoded) <= maxBytes);
      if (encoded !== verifiedPrevious) pending.push({ file: filename(id), encoded, unitIndex: preparationIndex });
    }
    await checkpoint();
    await assertCurrent();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const location of [path.dirname(directory), directory]) { const stat = await fs.lstat(location); need(stat.isDirectory() && !stat.isSymbolicLink()); }
    for (const { file, encoded, unitIndex } of pending) {
      // Retain the original group's logical slot when earlier verified files
      // were skipped. A retry must not lose its progress high-water position.
      setCooperativeWorkPhase(70, groups.size + unitIndex);
      await checkpoint();
      // A witness is independently verified and replaced atomically. Yield only
      // between complete files, never while a temporary file is being committed.
      await runNonInterruptibleCooperativeWork(async () => {
        const temporary = file + "." + crypto.randomUUID() + ".tmp"; let handle;
        try {
          handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
          await assertCurrent(); await fs.rename(temporary, file);
        } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
      });
    }
    return { companies: groups.size };
  }
  return { read, readForCompanies, readWithSignature, withDescriptorVerificationScope, stats: () => ({ ...metrics, maxVerificationDescriptors }), publish(evidence, context) {
    const task = serial.then(() => publishOwned(evidence, context));
    serial = task.then(() => undefined, () => undefined); return task;
  }, directory };
}
module.exports = { createProductCapacityStore, productCapacityCorrectionSignature: correctionSignature };
