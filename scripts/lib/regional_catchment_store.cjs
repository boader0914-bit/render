"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { VERSION, SOURCE_CATALOG, fault, hash, normalizeCenter, normalizeDataset, datasetMetadata, inputFingerprint, calculateCatchment, validateCatchmentResult } = require("./regional_catchment.cjs");

const copy = value => structuredClone(value);
const MAX_REVISIONS = 8;
const MAX_JOBS = 100;
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");
const safeCode = error => /^CATCHMENT_[A-Z0-9_]{1,80}$/.test(error?.code || "") ? error.code : "CATCHMENT_STORAGE_UNAVAILABLE";
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw fault("CATCHMENT_STORAGE_UNAVAILABLE", 503); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, file);
  } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
}
async function immutableJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
function assertKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault("CATCHMENT_INVALID_INPUT");
}
function actorLabel(actor) {
  const value = typeof actor === "string" ? actor : actor?.username || actor?.id || "administrator";
  return typeof value === "string" && /^[\p{L}\p{N}_.@ -]{1,100}$/u.test(value) ? value : "administrator";
}

function createRegionalCatchmentService({ dataDir, resolveRegion, now = () => new Date(), calculate = calculateCatchment } = {}) {
  if (!dataDir || typeof resolveRegion !== "function" || typeof calculate !== "function") throw new TypeError("dataDir and resolveRegion are required");
  const directory = path.resolve(dataDir, "regional_catchment"), stateFile = path.join(directory, "state.json");
  let state = { schemaVersion: 1, datasets: {}, configurations: {}, pointers: {}, jobs: {} }, initialized, storageError = null, closed = false;
  let serial = Promise.resolve(), worker = null;
  const timestamp = () => new Date(now()).toISOString();
  const locked = fn => { const task = serial.then(fn); serial = task.catch(() => {}); return task; };
  const regionHash = key => hash(key);
  const datasetFile = fingerprint => path.join(directory, "datasets", `${fingerprint}.json`);
  const resultFile = resultId => path.join(directory, "results", `${resultId}.json`);
  async function init() {
    if (!initialized) initialized = (async () => {
      const loaded = await readJson(stateFile);
      if (!loaded) return;
      if (loaded.schemaVersion !== 1 || ["datasets", "configurations", "pointers", "jobs"].some(key => !loaded[key] || typeof loaded[key] !== "object" || Array.isArray(loaded[key]))) throw fault("CATCHMENT_STORE_INVALID", 503);
      for (const [id, row] of Object.entries(loaded.datasets)) if (row.id !== id || !validHash(row.fingerprint) || row.normalizedBodySha256 !== row.fingerprint
        || !Number.isSafeInteger(row.cellCount) || row.cellCount < 1 || row.cellCount > 50000) throw fault("CATCHMENT_STORE_INVALID", 503);
      for (const [key, config] of Object.entries(loaded.configurations)) {
        const center = normalizeCenter({ latitude: config.center?.latitude, longitude: config.center?.longitude, label: config.center?.label, sourceUrl: config.center?.sourceUrl, confirmed: config.center?.confirmed });
        if (!validHash(key) || key !== regionHash(config.regionKey) || !Object.hasOwn(loaded.datasets, config.datasetId)
          || config.configurationFingerprint !== hash([config.regionKey, center, config.datasetId]) || config.inputFingerprint !== inputFingerprint(center, loaded.datasets[config.datasetId])
          || hash(center) !== hash(config.center)) throw fault("CATCHMENT_STORE_INVALID", 503);
      }
      for (const [id, job] of Object.entries(loaded.jobs)) {
        if (id !== job.id || !/^[a-f0-9-]{36}$/.test(id) || !validHash(job.inputFingerprint) || !["queued", "running", "completed", "failed", "superseded", "interrupted"].includes(job.status)) throw fault("CATCHMENT_STORE_INVALID", 503);
        // A GET never resumes calculations. An explicit local refresh may
        // safely retry an interrupted job without contacting a provider.
        if (["running", "queued"].includes(job.status)) { job.status = "interrupted"; job.errorCode = "CATCHMENT_CALCULATION_INTERRUPTED"; job.finishedAt = timestamp(); }
      }
      for (const [key, pointer] of Object.entries(loaded.pointers)) if (!validHash(key) || !validHash(pointer.inputFingerprint) || !/^[a-f0-9-]{36}$/.test(pointer.resultId || "")
        || !validHash(pointer.resultSha256) || !Array.isArray(pointer.revisions) || pointer.revisions.length > MAX_REVISIONS
        || pointer.revisions.some(row => !/^[a-f0-9-]{36}$/.test(row?.resultId || "") || !validHash(row?.resultSha256))) throw fault("CATCHMENT_STORE_INVALID", 503);
      state = loaded;
    })().catch(error => { storageError = safeCode(error); });
    return initialized;
  }
  function writable() { if (closed) throw fault("CATCHMENT_STORE_CLOSED", 503); if (storageError) throw fault(storageError, 503); }
  async function save() {
    try { await atomicJson(stateFile, state); }
    catch (error) { storageError = "CATCHMENT_STORAGE_UNAVAILABLE"; throw fault(storageError, 503); }
  }
  async function scope(input) {
    assertKeys(input, ["regionKey"]);
    if (typeof input.regionKey !== "string" || !input.regionKey || input.regionKey.length > 120) throw fault("CATCHMENT_INVALID_REGION");
    const region = await resolveRegion(input.regionKey);
    if (!region || region.regionKey !== input.regionKey || region.active === false || region.selectable === false || region.level && region.level !== "local" || region.unitType === "general_district") throw fault("CATCHMENT_INVALID_REGION");
    return { regionKey: region.regionKey, label: region.label || region.fullName || region.name || region.regionKey };
  }
  function latestJob(regionKey) {
    return Object.values(state.jobs).filter(job => job.regionKey === regionKey).sort((a, b) => b.sequence - a.sequence)[0] || null;
  }
  async function savedSnapshot(config) {
    const pointer = state.pointers[regionHash(config.regionKey)];
    if (!pointer || pointer.inputFingerprint !== config.inputFingerprint) return { snapshot: null, errorCode: null };
    let errorCode = null;
    const candidates = [pointer, ...pointer.revisions].slice(0, MAX_REVISIONS + 1), seen = new Set();
    for (const candidate of candidates) {
      const id = candidate.resultId;
      if (seen.has(id)) continue; seen.add(id);
      try {
        const result = await readJson(resultFile(id));
        if (!result || result.resultId !== id || hash(result) !== candidate.resultSha256) throw fault("CATCHMENT_RESULT_INVALID");
        // Different center/source revisions are retained but never displayed.
        if (result.sourceFingerprint !== config.inputFingerprint) continue;
        validateCatchmentResult(result, { regionKey: config.regionKey, center: config.center, datasetFingerprint: state.datasets[config.datasetId]?.fingerprint });
        return { snapshot: result, errorCode };
      } catch { errorCode = "CATCHMENT_RESULT_INVALID"; }
    }
    return { snapshot: null, errorCode };
  }
  async function get(input) {
    const selected = await scope(input); await init();
    // Reads are not placed behind file import/calculation publication. They
    // see an immutable published snapshot and never load the source grid.
    const config = state.configurations[regionHash(selected.regionKey)] || null;
    const job = copy(latestJob(selected.regionKey));
    const saved = config ? await savedSnapshot(copy(config)) : { snapshot: null, errorCode: null };
    const failure = job?.inputFingerprint === config?.inputFingerprint && ["failed", "interrupted"].includes(job?.status);
    const errorCode = storageError || saved.errorCode;
    return { scope: selected, status: saved.snapshot ? failure || errorCode ? "stale" : saved.snapshot.status : failure || errorCode ? "failed" : config ? "missing" : "unqueried",
      configuration: config ? copy(config) : null, datasets: Object.values(state.datasets).map(copy), snapshot: saved.snapshot, job,
      storage: { errorCode, lastReadSource: "stored_result", networkAttempted: false }, sourceCatalog: copy(SOURCE_CATALOG) };
  }
  async function importDataset(input, actor) {
    await init(); writable();
    const dataset = normalizeDataset(input);
    if (dataset.sourceYear > new Date(now()).getUTCFullYear() || dataset.boundaryYear > new Date(now()).getUTCFullYear()) throw fault("CATCHMENT_SOURCE_PERIOD_INVALID");
    return locked(async () => {
      writable();
      const prior = Object.hasOwn(state.datasets, dataset.id) ? state.datasets[dataset.id] : null;
      if (prior && prior.fingerprint !== dataset.fingerprint) throw fault("CATCHMENT_DATASET_ID_CONFLICT", 409);
      if (prior) return { dataset: copy(prior), reused: true };
      const metadata = { ...datasetMetadata(dataset), importedAt: timestamp(), importedBy: actorLabel(actor), sourceHashes: "administrator_declared", normalizedBodySha256: dataset.fingerprint };
      // The canonical imported body is immutable and independently hashed;
      // declared source hashes are metadata, not server verification claims.
      const file = datasetFile(dataset.fingerprint);
      try { await immutableJson(file, dataset); }
      catch (error) {
        if (error.code !== "EEXIST") throw fault("CATCHMENT_STORAGE_UNAVAILABLE", 503);
        const priorBody = await readJson(file);
        if (priorBody?.fingerprint !== dataset.fingerprint || hash(priorBody) !== hash(dataset)) throw fault("CATCHMENT_DATASET_INTEGRITY_ERROR", 503);
      }
      state.datasets[dataset.id] = metadata; await save();
      return { dataset: copy(metadata), reused: false };
    });
  }
  async function configure(input, actor) {
    assertKeys(input, ["regionKey", "center", "datasetId"]);
    const selected = await scope({ regionKey: input.regionKey }), center = normalizeCenter(input.center);
    if (typeof input.datasetId !== "string") throw fault("CATCHMENT_DATASET_REQUIRED");
    await init();
    return locked(async () => {
      writable(); const dataset = Object.hasOwn(state.datasets, input.datasetId) ? state.datasets[input.datasetId] : null;
      if (!dataset) throw fault("CATCHMENT_DATASET_NOT_FOUND", 404);
      const fingerprint = inputFingerprint(center, dataset), configKey = regionHash(selected.regionKey);
      const previous = state.configurations[configKey];
      if (previous?.inputFingerprint === fingerprint) return { configuration: copy(previous), reused: true };
      const config = { ...selected, center, datasetId: input.datasetId, inputFingerprint: fingerprint,
        configurationFingerprint: hash([selected.regionKey, center, input.datasetId]), configuredAt: timestamp(), configuredBy: actorLabel(actor) };
      state.configurations[configKey] = config; await save();
      return { configuration: copy(config), reused: false };
    });
  }
  function pruneJobs() {
    const finished = Object.values(state.jobs).filter(job => !["queued", "running"].includes(job.status)).sort((a, b) => b.sequence - a.sequence);
    for (const job of finished.slice(MAX_JOBS)) delete state.jobs[job.id];
  }
  async function request(input) {
    const selected = await scope(input); await init();
    const response = await locked(async () => {
      writable(); const config = state.configurations[regionHash(selected.regionKey)];
      if (!config) throw fault("CATCHMENT_CONFIGURATION_REQUIRED", 409);
      const active = Object.values(state.jobs).find(job => job.inputFingerprint === config.inputFingerprint && job.regionKey === config.regionKey && ["queued", "running"].includes(job.status));
      if (active) return { job: { ...copy(active), reused: true }, reused: true };
      const saved = await savedSnapshot(config);
      if (saved.snapshot && !saved.errorCode) return { snapshot: copy(saved.snapshot), job: null, reused: true };
      const job = { id: crypto.randomUUID(), regionKey: config.regionKey, inputFingerprint: config.inputFingerprint, configuration: copy(config),
        sequence: Math.max(0, ...Object.values(state.jobs).map(row => row.sequence || 0)) + 1,
        status: "queued", queuedAt: timestamp(), startedAt: null, finishedAt: null, errorCode: null };
      state.jobs[job.id] = job; pruneJobs(); await save(); return { job: copy(job), reused: false };
    });
    if (response.job) kick();
    return response;
  }
  async function processQueue() {
    while (!closed && !storageError) {
      const selected = await locked(async () => {
        const job = Object.values(state.jobs).filter(row => row.status === "queued").sort((a, b) => a.sequence - b.sequence)[0];
        if (!job) return null;
        job.status = "running"; job.startedAt = timestamp(); await save(); return copy(job);
      });
      if (!selected) break;
      let result, errorCode = null;
      try {
        const metadata = state.datasets[selected.configuration.datasetId];
        const body = await readJson(datasetFile(metadata.fingerprint));
        if (!body || body.fingerprint !== metadata.fingerprint) throw fault("CATCHMENT_DATASET_INTEGRITY_ERROR");
        // Revalidate stored bytes before using them. Corrupt source data never
        // replaces a previously published result.
        const { fingerprint: recordedFingerprint, ...input } = body;
        const dataset = normalizeDataset(input);
        if (dataset.fingerprint !== recordedFingerprint) throw fault("CATCHMENT_DATASET_INTEGRITY_ERROR");
        result = await calculate({ ...selected.configuration, dataset, now });
        if (result.sourceFingerprint !== selected.inputFingerprint) throw fault("CATCHMENT_RESULT_INVALID");
        validateCatchmentResult(result, { regionKey: selected.regionKey, center: selected.configuration.center, datasetFingerprint: dataset.fingerprint, requireResultId: false });
      } catch (error) { errorCode = safeCode(error); }
      await locked(async () => {
        const job = state.jobs[selected.id], config = state.configurations[regionHash(selected.regionKey)];
        if (!job) return;
        job.finishedAt = timestamp(); job.elapsedMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt));
        if (config?.inputFingerprint !== selected.inputFingerprint) { job.status = "superseded"; await save(); return; }
        if (errorCode) { job.status = "failed"; job.errorCode = errorCode; await save(); return; }
        const key = regionHash(selected.regionKey), old = state.pointers[key];
        const resultId = crypto.randomUUID(); result = { ...result, resultId };
        try {
          validateCatchmentResult(result, { regionKey: config.regionKey, center: config.center, datasetFingerprint: state.datasets[config.datasetId].fingerprint });
          await immutableJson(resultFile(resultId), result);
          const revisions = old ? [{ resultId: old.resultId, resultSha256: old.resultSha256 }, ...(old.revisions || [])] : [];
          const seen = new Set();
          state.pointers[key] = { resultId, resultSha256: hash(result), inputFingerprint: selected.inputFingerprint,
            revisions: revisions.filter(row => { if (seen.has(row.resultId)) return false; seen.add(row.resultId); return true; }).slice(0, MAX_REVISIONS) };
          job.status = "completed"; job.resultId = resultId; job.errorCode = null; await save();
        } catch { state.pointers[key] = old; job.status = "failed"; job.errorCode = "CATCHMENT_STORAGE_UNAVAILABLE"; }
      });
    }
  }
  function kick() {
    if (worker || closed || storageError) return worker;
    worker = Promise.resolve().then(processQueue).catch(error => { storageError = safeCode(error); }).finally(() => { worker = null; });
    return worker;
  }
  async function waitForIdle() { await init(); await serial; while (worker) { await worker; await serial; } }
  async function close() { closed = true; await waitForIdle(); }
  return { get, configure, importDataset, request, close, waitForIdle };
}

module.exports = { createRegionalCatchmentService };
