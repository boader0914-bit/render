"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
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
function createCompanyCapacityRegistry({ dataDir, observedCapacity, reviewedCapacity, now = () => new Date() }) {
  const file = path.join(dataDir, "company_integrated", "capacity-bases.json");
  let chain = Promise.resolve(), historyCache = null;
  async function historicalMaxima(companies, runs) {
    const filename = path.join(dataDir, "history", "observations.jsonl");
    let stat; try { stat = await fs.stat(filename); } catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
    const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown")]));
    const identities = new Map();
    for (const company of Object.values(companies)) {
      if (!company?.companyId || company.deletedAt || company.mergedIntoCompanyId) continue;
      identities.set(company.companyId, company.companyId);
      for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) identities.set(prior.mergedCompanyId, company.companyId);
    }
    const key = crypto.createHash("sha256").update(JSON.stringify([stat.size, stat.mtimeMs, [...runMap], [...identities]])).digest("hex");
    if (historyCache?.key === key) return historyCache.values;
    const values = new Map();
    const input = readline.createInterface({ input: require("node:fs").createReadStream(filename, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of input) {
      let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { continue; }
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const id = identities.get(String(row.companyId || row.companyKey || ""));
      if (!id || row.productType !== "lodging" || !["complete", "reused", "partial"].includes(runMap.get(String(row.runId || "")))
        || !trustedRawQuantity(row)) continue;
      // supply/total can contain prior inferred capacity and must not seed a baseline.
      const count = positive(row.rawTotal);
      if (count) values.set(id, Math.max(values.get(id) || 0, count));
    }
    historyCache = { key, values }; return values;
  }
  async function prepare(companies, { runs = [] } = {}) {
    const historical = await historicalMaxima(companies, runs);
    const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown")]));
    let store;
    try { store = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw Object.assign(new Error("객실 기준 기록을 읽지 못했습니다."), { code: "CAPACITY_BASIS_UNAVAILABLE" }); store = { schemaVersion: 1, companies: {} }; }
    if (store.schemaVersion !== 1 || !store.companies || Array.isArray(store.companies)) throw new Error("CAPACITY_BASIS_UNAVAILABLE");
    let dirty = false;
    const result = {};
    for (const [id, original] of Object.entries(companies)) {
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
      const company = structuredClone(original);
      company._integratedCapacity = { capacity: count, count, source, revision: basis.revision, updatedAt: basis.updatedAt, observedMaximum: observed, warnings,
        label: reviewed ? "관리자 검수값" : count ? "최대 관측 기준 고정 · 미검수" : "객실 기준 확인 필요" };
      if (count && !reviewed) company.manualCorrection = { ...(company.manualCorrection?.active === false ? {} : company.manualCorrection || {}), active: true, lodgingBasisTotal: count, source: "integrated_observed_basis" };
      result[id] = company;
    }
    if (dirty) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(store), "utf8"); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }
    return result;
  }
  return { prepareCompanies(companies, context) { const task = chain.then(() => prepare(companies, context)); chain = task.catch(() => {}); return task; } };
}
module.exports = { createCompanyCapacityRegistry };
