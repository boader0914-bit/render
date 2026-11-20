"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { getAnalyticalPhaseDiagnostics } = require("./analytical_phase_runtime.cjs");
const { runCooperativeCheckpointReads } = require("./cooperative_work_checkpoint.cjs");

const monthOf = value => /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(String(value || "")) ? String(value).slice(0, 7) : null;
const MAX_CACHED_SCOPES = 16;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const targetFault = code => Object.assign(new Error("업체별 관측 월의 변경 여부를 확인하지 못했습니다."), { code, statusCode: 503 });
// This index discovers scopes only. The monthly engine independently checks
// identity, timestamps, source quality, counts and prices before accepting data.
function createCompanyIntegratedTargets({ dataDir, catalog, readRevision, maxCacheBytes = MAX_CACHE_BYTES, observationIndex = null,
  checkpoint = async () => {
    await new Promise(resolve => setImmediate(resolve));
    // Existing pure discovery boundaries only. The exact background owner
    // stays suspended through a saved DTO and its complete HTTP lifetime.
    // This does not lend revision reads, filesystem waits or publication.
    await runCooperativeCheckpointReads();
  } } = {}) {
  if (!dataDir || typeof catalog !== "function" || readRevision !== undefined && typeof readRevision !== "function") throw new TypeError("Target data directory, catalog and optional revision reader are required");
  if (observationIndex !== null && typeof observationIndex.readRows !== "function") throw new TypeError("A verified observation index is required");
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || maxCacheBytes > MAX_CACHE_BYTES) throw new TypeError("Target cache byte limit must be between zero and 8 MiB");
  if (typeof checkpoint !== "function") throw new TypeError("Target checkpoint must be a function");
  // Only serialized company/month projections survive a discovery. Source
  // catalogs, observations and inventory bodies never enter this cache.
  const cache = new Map(), flights = new Map();
  let cacheBytes = 0;
  const allScope = "all";
  async function revision() {
    let value;
    try { value = await readRevision(); } catch { throw targetFault("COMPANY_TARGET_SOURCE_UNAVAILABLE"); }
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw targetFault("COMPANY_TARGET_SOURCE_UNAVAILABLE");
    return value;
  }
  function remember(key, entry) {
    // Oversized projections remain complete in the current response, but do
    // not displace the last verified entry or enter the retained cache.
    if (entry.bytes > maxCacheBytes) return;
    const prior = cache.get(key);
    if (prior) cacheBytes -= prior.bytes;
    cache.delete(key); cache.set(key, entry); cacheBytes += entry.bytes;
    while (cache.size > MAX_CACHED_SCOPES || cacheBytes > maxCacheBytes) {
      // The shared all-history scope serves consecutive company jobs. Never
      // evict it just because an administrator inspects many individual runs.
      const oldest = [...cache.keys()].find(candidate => candidate !== allScope);
      const evicted = oldest === undefined ? cache.keys().next().value : oldest;
      cacheBytes -= cache.get(evicted).bytes; cache.delete(evicted);
    }
  }
  async function readCatalogMetadata() {
    const phases = getAnalyticalPhaseDiagnostics(), counts = { rowCount: 0, partitionCount: 0 };
    const data = await phases.measure("target_catalog_read", {}, () => catalog());
    return phases.measure("target_metadata_project", counts, async () => {
    const activeIds = new Set(), companies = [];
    for (const [key, company] of data.rawCompanies) {
      await checkpoint(); counts.partitionCount++;
      if (!company || company.deletedAt || company.mergedIntoCompanyId) continue;
      activeIds.add(key);
      const knownRunIds = new Set();
      for (const id of company.runIds || []) { knownRunIds.add(id); if (++counts.rowCount % 256 === 0) await checkpoint(); }
      knownRunIds.add(company.firstRunId); knownRunIds.add(company.lastRunId);
      for (const exposure of Object.values(company.keywords || {})) {
        if (++counts.rowCount % 256 === 0) await checkpoint();
        for (const row of exposure.runs || []) { knownRunIds.add(row.runId); if (++counts.rowCount % 256 === 0) await checkpoint(); }
      }
      const snapshotDates = [];
      function* snapshots() { yield company.inventory?.latest; yield company.inventory?.previousLatest; yield* company.inventory?.snapshots || []; }
      for (const snapshot of snapshots()) {
        if (++counts.rowCount % 256 === 0) await checkpoint();
        if (!snapshot) continue;
        knownRunIds.add(snapshot.runId);
        for (const row of snapshot.productSnapshot?.daily || []) {
          snapshotDates.push({ date: String(row.stayDate || row.date || ""), runId: row.runId || snapshot.runId });
          if (++counts.rowCount % 256 === 0) await checkpoint();
        }
      }
      const mergedIds = [], placeIds = [], runIds = [];
      for (const prior of company.duplicateNotes || []) { if (prior.mergedCompanyId) mergedIds.push(prior.mergedCompanyId); if (++counts.rowCount % 256 === 0) await checkpoint(); }
      for (const place of company.placeIds || []) { placeIds.push(String(place)); if (++counts.rowCount % 256 === 0) await checkpoint(); }
      for (const id of knownRunIds) { if (id === null || typeof id !== "object") runIds.push(id); if (++counts.rowCount % 256 === 0) await checkpoint(); }
      companies.push({ companyId: company.companyId, mergedIds, placeIds, snapshotDates, knownRunIds: runIds });
    }
    // Target discovery only needs identities and calendar scope. In particular,
    // do not retain complete companies, product snapshots, daily rows or raw
    // run payloads while the asynchronous history stream is being consumed.
    const runs = new Map();
    for (const run of data.runs) {
      runs.set(String(run.id || run.runId), { checkIn: String(run.checkIn || ""), bookingRangeDays: Number(run.bookingRangeDays) });
      if (++counts.rowCount % 256 === 0) await checkpoint();
    }
    return { activeIds, companies, runs };
    });
  }
  async function discover({ runId = null, companyIds = null } = {}) {
    const data = await readCatalogMetadata();
    const active = data.activeIds, phases = getAnalyticalPhaseDiagnostics();
    const ids = new Map(), places = new Map(), byCompany = new Map();
    const identityCounts = { rowCount: 0, partitionCount: 0 };
    await phases.measure("target_identity_index", identityCounts, async () => {
    for (const company of data.companies) {
      await checkpoint(); identityCounts.partitionCount++;
      ids.set(company.companyId, company.companyId);
      for (const mergedId of company.mergedIds) { ids.set(mergedId, company.companyId); if (++identityCounts.rowCount % 256 === 0) await checkpoint(); }
      for (const place of company.placeIds) { places.set(place, places.has(place) && places.get(place) !== company.companyId ? null : company.companyId); if (++identityCounts.rowCount % 256 === 0) await checkpoint(); }
    }
    });
    const requested = companyIds ? new Set(companyIds.map(String)) : null;
    function add(id, date, sourceRunId) {
      if (!id || !active.has(id) || (requested && !requested.has(id)) || (runId && sourceRunId !== runId)) return;
      const month = monthOf(date); if (!month) return;
      if (!byCompany.has(id)) byCompany.set(id, new Set());
      byCompany.get(id).add(month);
    }
    const history = path.join(dataDir, "history", "observations.jsonl");
    const historyCounts = { rowCount: 0, readCount: 0 };
    let historySinceCheckpoint = 0, historyCheckpointAt = performance.now();
    const historyBoundary = () => {
      // A cold SQLite header may fetch overflow pages from a large raw row.
      // Its index's 256-row boundary can be too coarse for this lightweight scope
      // reader: yield after at most 16 headers/lines or 10ms of observed work.
      if (++historySinceCheckpoint < 16 && performance.now() - historyCheckpointAt < 10) return null;
      historySinceCheckpoint = 0;
      return Promise.resolve(checkpoint()).then(() => { historyCheckpointAt = performance.now(); });
    };
    function consume(row) {
      historyCounts.rowCount++;
      // Keep discovery's historical companyId-first resolution. The shared
      // index retains both raw references instead of silently canonicalizing.
      const key = String(row.companyId || row.companyKey || "");
      const id = ids.get(key) || places.get(String(row.placeId || key.match(/^cmp_place_(.+)$/)?.[1] || ""));
      add(id, row.stayDate || row.date, row.runId);
    }
    const historyPhase = observationIndex ? typeof observationIndex.readHeaders === "function" ? "target_history_header_read" : "target_history_row_read" : "target_history_jsonl_read";
    await phases.measure(historyPhase, historyCounts, async () => {
    if (observationIndex) {
      const read = typeof observationIndex.readHeaders === "function" ? observationIndex.readHeaders : observationIndex.readRows;
      await read.call(observationIndex, { parseMode: "monthly", ...(runId ? { runId } : {}) }, async row => {
        historyCounts.readCount++; consume(row); const pause = historyBoundary(); if (pause) await pause;
      });
    }
    else try {
      await fsp.access(history);
      const stream = fs.createReadStream(history, { encoding: "utf8" });
      const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try { for await (const line of input) {
        historyCounts.readCount++; const pause = historyBoundary(); if (pause) await pause;
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { continue; }
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        consume(row);
      } } finally { input.close(); stream.destroy(); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    });
    const scopeCounts = { rowCount: 0, partitionCount: 0 };
    await phases.measure("target_snapshot_merge", scopeCounts, async () => {
    for (const company of data.companies) {
      await checkpoint(); scopeCounts.partitionCount++;
      for (const row of company.snapshotDates) { add(company.companyId, row.date, row.runId); if (++scopeCounts.rowCount % 256 === 0) await checkpoint(); }
      for (const id of company.knownRunIds) {
        if (++scopeCounts.rowCount % 256 === 0) await checkpoint();
        const run = data.runs.get(id); if (!run || (runId && runId !== id)) continue;
        const start = String(run.checkIn || "");
        if (!monthOf(start)) continue;
        const time = Date.parse(`${start}T00:00:00Z`);
        if (!Number.isFinite(time)) continue;
        const days = Number(run.bookingRangeDays);
        // Missing span does not invent 31 days. Actual rows above remain primary.
        const span = Number.isSafeInteger(days) && days > 0 && days <= 366 ? days : 1;
        for (let i = 0; i < span; i++) {
          add(company.companyId, new Date(time + i * 86400000).toISOString().slice(0, 10), id);
          if (++scopeCounts.rowCount % 256 === 0) await checkpoint();
        }
      }
    }
    });
    const result = [];
    for (const [companyId, months] of byCompany) { await checkpoint(); result.push({ companyId, months: [...months].sort() }); }
    return result.sort((a, b) => a.companyId.localeCompare(b.companyId));
  }
  function discovered(key, runId, before) {
    if (flights.has(key)) return flights.get(key);
    if (flights.size >= MAX_CACHED_SCOPES) throw targetFault("COMPANY_TARGET_DISCOVERY_BUSY");
    const task = (async () => {
      let rows;
      try { rows = await discover({ runId }); }
      catch { throw targetFault("COMPANY_TARGET_SOURCE_UNAVAILABLE"); }
      if (await getAnalyticalPhaseDiagnostics().measure("target_revision_verify", {}, () => revision()) !== before) throw targetFault("COMPANY_TARGET_SOURCE_CHANGED");
      const json = JSON.stringify(rows);
      const entry = { revision: before, json, bytes: Buffer.byteLength(json) + Buffer.byteLength(key) + Buffer.byteLength(before) };
      remember(key, entry); return entry;
    })();
    flights.set(key, task);
    task.finally(() => { if (flights.get(key) === task) flights.delete(key); }).catch(() => {});
    return task;
  }
  return async function listTargets({ runId = null, companyIds = null } = {}) {
    // Preserve the former behavior for callers without a complete source
    // revision. A time-to-live is never a substitute for source verification.
    if (!readRevision) return discover({ runId, companyIds });
    const requested = companyIds ? new Set(companyIds.map(String)) : null;
    const key = runId ? `run:${JSON.stringify(runId)}` : allScope;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await revision();
      let entry = cache.get(key);
      try {
        if (!entry || entry.revision !== before) entry = await discovered(key, runId, before);
      } catch (error) {
        if (error.code === "COMPANY_TARGET_SOURCE_CHANGED" && attempt === 0) continue;
        throw error;
      }
      const after = await revision();
      if (entry.revision === before && after === before) {
        remember(key, entry);
        return JSON.parse(entry.json).filter(row => !requested || requested.has(row.companyId));
      }
    }
    // Keep the last verified entry available for later rechecks, but never
    // present it as current when the source changed during this request.
    throw targetFault("COMPANY_TARGET_SOURCE_CHANGED");
  };
}
module.exports = { createCompanyIntegratedTargets };
