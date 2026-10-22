"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const HISTORY_CACHE_VERSION = 1, HISTORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex");
const historyFault = () => Object.assign(new Error("객실 기준의 관측 색인을 검증하지 못했습니다."), { code: "CAPACITY_HISTORY_INDEX_UNAVAILABLE", statusCode: 503 });
const positive = value => ["number", "string"].includes(typeof value) && String(value).trim() !== ""
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function trustedRawQuantity(row) {
  // Version absence is not version zero: NaN < 3 is false. Require positive
  // proof of the evidence version and preserve explicit provider failure flags.
  if (!["number", "string"].includes(typeof row.inventoryEvidenceVersion)
    || !(Number.isSafeInteger(Number(row.inventoryEvidenceVersion)) && Number(row.inventoryEvidenceVersion) >= 3)) return false;
  if (row.partial || row.missing || row.inventoryConflict || row.capacityConflict || row.collectionFailed
    || row.failed || row.error || row.collectionErrorCode || (Array.isArray(row.errors) && row.errors.length)
    || row.sharedDayUseIncomplete || Number(row.unknownUnavailable) > 0 || Number(row.responseStatus) >= 400) return false;
  if (["error", "failed", "blocked", "missing", "partial", "unobserved", "not_requested", "unknown", "interrupted", "cancelled", "canceled"]
    .includes(String(row.observationStatus || row.status || "").toLowerCase())) return false;
  if (["inventoryObserved", "stockObserved", "scheduleObserved", "queryAttempted"].some(field => row[field] === false)) return false;
  return true;
}
function trustedSnapshotCompany(company, runMap) {
  const filter = snapshot => {
    if (!snapshot || typeof snapshot !== "object") return null;
    const product = snapshot.productSnapshot;
    if (!product || !Array.isArray(product.daily)) return null;
    const version = product.inventoryEvidenceVersion ?? snapshot.inventoryEvidenceVersion;
    if (!trustedRawQuantity({ ...snapshot, inventoryEvidenceVersion: version })
      || !trustedRawQuantity({ ...product, inventoryEvidenceVersion: version })) return null;
    const daily = product.daily.filter(row => {
      if (!row || row.productType !== "lodging" || !positive(row.rawTotal)) return false;
      // Merged product snapshots can retain daily evidence from an older run.
      // Its recorded source takes priority over the latest wrapper's run ID.
      const runId = String(row.runId || product.dailyRunId || product.runId || snapshot.runId || "");
      return ["complete", "reused", "partial"].includes(runMap.get(runId))
        && trustedRawQuantity({ ...row, inventoryEvidenceVersion: row.inventoryEvidenceVersion ?? version });
    }).map(row => ({ ...row }));
    if (!daily.length) return null;
    const maximum = Math.max(...daily.map(row => positive(row.rawTotal)));
    // The existing maximum callback also reads this summary. Replace it with
    // the validated same-date maxima so failed/omitted rows cannot leak through
    // a higher cached summary, nor through legacy stockBasis fallback.
    const capacityBasis = { ...(product.capacityBasis || snapshot.capacityBasis || {}), currentObservedMaximum: maximum, observedMaximum: maximum };
    return { ...snapshot, capacityBasis, stockBasis: {}, productSnapshot: { ...product, capacityBasis, daily } };
  };
  const inventory = company.inventory || {};
  return { ...company, inventory: { ...inventory, latest: filter(inventory.latest), previousLatest: filter(inventory.previousLatest),
    snapshots: (Array.isArray(inventory.snapshots) ? inventory.snapshots : []).map(filter).filter(Boolean) } };
}
// Derived, versioned capacity basis. Raw company records are never modified.
function createCompanyCapacityRegistry({ dataDir, observedCapacity, reviewedCapacity, now = () => new Date(), observationIndex = null }) {
  if (observationIndex !== null && ["ensure", "revisionPartitions", "readRows"].some(method => typeof observationIndex[method] !== "function")) throw new TypeError("A verified observation index is required");
  const file = path.join(dataDir, "company_integrated", "capacity-bases.json");
  const historyCacheFile = path.join(dataDir, "company_integrated", "capacity-history-index.json");
  let chain = Promise.resolve(), historyCache = null, projectionCache = null, projectionStat = null, rulePromise = null;
  const stamp = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
  async function readProjection() {
    let before;
    try { before = await fs.lstat(historyCacheFile, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") { projectionCache = null; projectionStat = null; return null; } throw historyFault(); }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(HISTORY_CACHE_MAX_BYTES)) throw historyFault();
    if (projectionCache && projectionStat === stamp(before)) return projectionCache;
    let value;
    try { value = JSON.parse(await fs.readFile(historyCacheFile, "utf8")); }
    catch { throw historyFault(); }
    const { checksum, ...body } = value || {};
    if (body.schemaVersion !== HISTORY_CACHE_VERSION || !/^[a-f0-9]{64}$/.test(body.ruleVersion || "")
      || !/^[a-f0-9]{64}$/.test(body.sourceDigest || "") || !Array.isArray(body.partitions) || checksum !== digest(body)) throw historyFault();
    const keys = new Set();
    for (const part of body.partitions) {
      if (!part || typeof part.key !== "string" || keys.has(part.key) || !/^[a-f0-9]{64}$/.test(part.digest || "")
        || typeof part.rawCompanyId !== "string" || !Array.isArray(part.runs)) throw historyFault();
      keys.add(part.key);
      const runs = new Set();
      for (const item of part.runs) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || runs.has(item[0]) || !positive(item[1])) throw historyFault();
        runs.add(item[0]);
      }
    }
    const after = await fs.lstat(historyCacheFile, { bigint: true }).catch(() => null);
    if (!after || after.isSymbolicLink() || stamp(after) !== stamp(before)) throw historyFault();
    projectionCache = body; projectionStat = stamp(after); return body;
  }
  function validDescriptor(value) {
    return value && /^[a-f0-9]{64}$/.test(value.contentDigest || "") && Number.isSafeInteger(value.generation) && value.generation >= 0
      && (!value.source || typeof value.source.signature === "string");
  }
  async function assertDescriptor(before) {
    const after = await observationIndex.ensure();
    if (!validDescriptor(after) || after.generation !== before.generation || after.contentDigest !== before.contentDigest
      || (after.source?.signature || null) !== (before.source?.signature || null)) throw historyFault();
  }
  async function saveProjection(body, before) {
    const encoded = JSON.stringify({ ...body, checksum: digest(body) });
    if (Buffer.byteLength(encoded) > HISTORY_CACHE_MAX_BYTES) throw historyFault();
    await fs.mkdir(path.dirname(historyCacheFile), { recursive: true });
    const temporary = `${historyCacheFile}.${crypto.randomUUID()}.tmp`; let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
      // An interrupted index read cannot replace the last verified projection.
      await assertDescriptor(before);
      await fs.rename(temporary, historyCacheFile);
      projectionCache = body; projectionStat = stamp(await fs.lstat(historyCacheFile, { bigint: true }));
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
  async function indexedHistoricalMaxima(companies, runs, checkpoint) {
    try {
      const before = await observationIndex.ensure(); if (!validDescriptor(before)) throw historyFault();
      const index = await observationIndex.revisionPartitions();
      if (!index || index.contentDigest !== before.contentDigest || (index.source?.signature || null) !== (before.source?.signature || null)
        || !Array.isArray(index.partitions)) throw historyFault();
      // Raw trust rules are versioned separately from mutable run quality and
      // canonical ownership. Those are applied afresh on every preparation.
      if (!rulePromise) rulePromise = fs.readFile(__filename).then(bytes => digest(Buffer.concat([Buffer.from("capacity-raw-partition-v1\n"), bytes])));
      const ruleVersion = await rulePromise, previous = await readProjection();
      const reusable = new Map(previous?.ruleVersion === ruleVersion ? previous.partitions.map(part => [part.key, part]) : []);
      const partitions = [], seen = new Set(); let count = 0;
      for (const part of index.partitions) {
        if (!part || typeof part.key !== "string" || seen.has(part.key) || !/^[a-f0-9]{64}$/.test(part.digest || "")
          || !Number.isSafeInteger(part.count) || part.count < 1) throw historyFault();
        seen.add(part.key);
        const rawCompanyId = String(part.companyId || part.companyKey || ""), cached = reusable.get(part.key);
        if (cached?.digest === part.digest && cached.rawCompanyId === rawCompanyId) partitions.push(cached);
        else {
          const maxima = new Map(); let rows = 0;
          await observationIndex.readRows({ parseMode: "monthly", partitionKey: part.key }, row => {
            rows++;
            if (!row || typeof row !== "object" || Array.isArray(row) || String(row.companyId || row.companyKey || "") !== rawCompanyId) throw historyFault();
            if (row.productType !== "lodging" || !trustedRawQuantity(row)) return;
            const quantity = positive(row.rawTotal); if (!quantity) return;
            const runId = String(row.runId || ""); maxima.set(runId, Math.max(maxima.get(runId) || 0, quantity));
          });
          if (rows !== part.count) throw historyFault();
          partitions.push({ key: part.key, digest: part.digest, rawCompanyId, runs: [...maxima].sort((a, b) => a[0].localeCompare(b[0])) });
        }
        if (checkpoint && ++count % 64 === 0) await checkpoint();
      }
      partitions.sort((a, b) => a.key.localeCompare(b.key));
      const body = { schemaVersion: HISTORY_CACHE_VERSION, ruleVersion, sourceDigest: before.contentDigest, partitions };
      const identities = new Map(); count = 0;
      for (const company of Object.values(companies)) {
        if (checkpoint && ++count % 16 === 0) await checkpoint();
        if (!company?.companyId || company.deletedAt || company.mergedIntoCompanyId) continue;
        identities.set(company.companyId, company.companyId);
        for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) identities.set(prior.mergedCompanyId, company.companyId);
      }
      const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown")]));
      const values = new Map(); count = 0;
      for (const part of partitions) {
        const id = identities.get(part.rawCompanyId);
        if (id) for (const [runId, quantity] of part.runs) if (["complete", "reused", "partial"].includes(runMap.get(runId))) values.set(id, Math.max(values.get(id) || 0, quantity));
        if (checkpoint && ++count % 128 === 0) await checkpoint();
      }
      await assertDescriptor(before);
      if (!previous || digest(body) !== digest(previous)) await saveProjection(body, before);
      return values;
    } catch (error) { throw error?.code === "CAPACITY_HISTORY_INDEX_UNAVAILABLE" ? error : historyFault(); }
  }
  async function legacyHistoricalMaxima(companies, runs, checkpoint) {
    const filename = path.join(dataDir, "history", "observations.jsonl");
    let stat; try { stat = await fs.stat(filename); } catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
    const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown")]));
    const identities = new Map();
    let companyCount = 0;
    for (const company of Object.values(companies)) {
      if (checkpoint && ++companyCount % 16 === 0) await checkpoint();
      if (!company?.companyId || company.deletedAt || company.mergedIntoCompanyId) continue;
      identities.set(company.companyId, company.companyId);
      for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) identities.set(prior.mergedCompanyId, company.companyId);
    }
    if (checkpoint) await checkpoint();
    const key = crypto.createHash("sha256").update(JSON.stringify([stat.size, stat.mtimeMs, [...runMap], [...identities]])).digest("hex");
    if (historyCache?.key === key) return historyCache.values;
    const values = new Map();
    const stream = require("node:fs").createReadStream(filename, { encoding: "utf8" });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;
    try {
      for await (const line of input) {
        // Keep the registry chain held. This only yields CPU/event-loop work;
        // starting a second capacity preparation here would duplicate its heap.
        if (checkpoint && ++lineCount % 256 === 0) await checkpoint();
        let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { continue; }
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const id = identities.get(String(row.companyId || row.companyKey || ""));
        if (!id || row.productType !== "lodging" || !["complete", "reused", "partial"].includes(runMap.get(String(row.runId || "")))
          || !trustedRawQuantity(row)) continue;
        // supply/total can contain prior inferred capacity and must not seed a baseline.
        const count = positive(row.rawTotal);
        if (count) values.set(id, Math.max(values.get(id) || 0, count));
      }
    } finally { input.close(); stream.destroy(); }
    historyCache = { key, values }; return values;
  }
  async function prepare(companies, { runs = [], checkpoint: suppliedCheckpoint = null, shareReadOnlyInventory = false } = {}) {
    const checkpoint = typeof suppliedCheckpoint === "function" ? suppliedCheckpoint : null;
    if (checkpoint) await checkpoint();
    const historical = await (observationIndex ? indexedHistoricalMaxima(companies, runs, checkpoint) : legacyHistoricalMaxima(companies, runs, checkpoint));
    const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown")]));
    let store, storedText;
    try { storedText = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw Object.assign(new Error("객실 기준 기록을 읽지 못했습니다."), { code: "CAPACITY_BASIS_UNAVAILABLE" }); store = { schemaVersion: 1, companies: {} }; }
    if (storedText !== undefined) {
      if (checkpoint) await checkpoint();
      try { store = JSON.parse(storedText); }
      catch { throw Object.assign(new Error("객실 기준 기록을 읽지 못했습니다."), { code: "CAPACITY_BASIS_UNAVAILABLE" }); }
    }
    if (store.schemaVersion !== 1 || !store.companies || Array.isArray(store.companies)) throw new Error("CAPACITY_BASIS_UNAVAILABLE");
    let dirty = false;
    const result = {};
    let companyCount = 0;
    for (const [id, original] of Object.entries(companies)) {
      if (checkpoint && ++companyCount % 16 === 0) await checkpoint();
      if (!original || original.deletedAt || original.mergedIntoCompanyId) { result[id] = original; continue; }
      const observed = positive(Math.max(positive(observedCapacity(trustedSnapshotCompany(original, runMap))) || 0, historical.get(id) || 0));
      const reviewed = positive(reviewedCapacity(original));
      const prior = store.companies[id];
      const reviewSignature = crypto.createHash("sha256").update(JSON.stringify([reviewed, original.manualCorrectionRevision || 0, original.manualCorrection || null])).digest("hex");
      const changedReview = prior && prior.reviewSignature !== reviewSignature;
      const count = reviewed || (changedReview && prior.source === "db_review" ? observed : positive(prior?.count)) || observed;
      const source = reviewed ? "db_review" : count ? "observed_locked" : "unknown";
      if (!prior || prior.count !== count || prior.source !== source || changedReview) {
        const current = { count, source, revision: (prior?.revision || 0) + 1, reviewSignature, updatedAt: now().toISOString(), appliesTo: "current_review_of_saved_history" };
        store.companies[id] = { ...current, history: [...(prior?.history || []), ...(prior ? [{ count: prior.count, source: prior.source, revision: prior.revision, updatedAt: prior.updatedAt }] : [])] };
        dirty = true;
      }
      const basis = store.companies[id];
      const warnings = !count ? ["객실 기준을 확인할 수 없습니다."] : !reviewed && observed > count ? [`관측 수량 ${observed}실이 고정 기준 ${count}실보다 큽니다. 관리자 검토가 필요합니다.`] : [];
      // Monthly source reconstruction owns these freshly streamed records and
      // only reads their inventory. Replace the two derived top-level fields
      // without cloning every saved product a second time. Other callers keep
      // the independent deep-copy contract by default.
      const company = shareReadOnlyInventory ? { ...original } : structuredClone(original);
      company._integratedCapacity = { capacity: count, count, source, revision: basis.revision, updatedAt: basis.updatedAt, observedMaximum: observed, warnings,
        label: reviewed ? "관리자 검수값" : count ? "최대 관측 기준 고정 · 미검수" : "객실 기준 확인 필요" };
      if (count && !reviewed) company.manualCorrection = { ...(company.manualCorrection?.active === false ? {} : company.manualCorrection || {}), active: true, lodgingBasisTotal: count, source: "integrated_observed_basis" };
      result[id] = company;
    }
    if (dirty) {
      if (checkpoint) await checkpoint();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(store), "utf8"); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }
    return result;
  }
  return { prepareCompanies(companies, context) {
    const task = chain.then(() => prepare(companies, context));
    // Serialize future work without retaining the completed full inventory.
    // The caller still owns the original result/error-bearing task.
    chain = task.then(() => undefined, () => undefined);
    return task;
  } };
}
module.exports = { createCompanyCapacityRegistry };
