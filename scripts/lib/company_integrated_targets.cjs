"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const monthOf = value => /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(String(value || "")) ? String(value).slice(0, 7) : null;
// This index discovers scopes only. The monthly engine independently checks
// identity, timestamps, source quality, counts and prices before accepting data.
function createCompanyIntegratedTargets({ dataDir, catalog }) {
  return async function listTargets({ runId = null, companyIds = null } = {}) {
    const data = await catalog();
    const active = data.rawCompanies;
    const ids = new Map(), places = new Map(), byCompany = new Map();
    for (const company of active.values()) {
      ids.set(company.companyId, company.companyId);
      for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) ids.set(prior.mergedCompanyId, company.companyId);
      for (const place of company.placeIds || []) places.set(String(place), places.has(String(place)) && places.get(String(place)) !== company.companyId ? null : company.companyId);
    }
    const requested = companyIds ? new Set(companyIds.map(String)) : null;
    function add(id, date, sourceRunId) {
      if (!id || !active.has(id) || (requested && !requested.has(id)) || (runId && sourceRunId !== runId)) return;
      const month = monthOf(date); if (!month) return;
      if (!byCompany.has(id)) byCompany.set(id, new Set());
      byCompany.get(id).add(month);
    }
    const history = path.join(dataDir, "history", "observations.jsonl");
    try {
      await fsp.access(history);
      const input = readline.createInterface({ input: fs.createReadStream(history, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of input) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { continue; }
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const key = String(row.companyId || row.companyKey || "");
        const id = ids.get(key) || places.get(String(row.placeId || key.match(/^cmp_place_(.+)$/)?.[1] || ""));
        add(id, row.stayDate || row.date, row.runId);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const runs = new Map(data.runs.map(run => [String(run.id || run.runId), run]));
    for (const company of active.values()) {
      const knownRunIds = new Set([...(company.runIds || []), company.firstRunId, company.lastRunId]);
      for (const exposure of Object.values(company.keywords || {})) for (const row of exposure.runs || []) knownRunIds.add(row.runId);
      for (const snapshot of [company.inventory?.latest, company.inventory?.previousLatest, ...(company.inventory?.snapshots || [])].filter(Boolean)) {
        knownRunIds.add(snapshot.runId);
        for (const row of snapshot.productSnapshot?.daily || []) add(company.companyId, row.stayDate || row.date, row.runId || snapshot.runId);
      }
      for (const id of knownRunIds) {
        const run = runs.get(id); if (!run || (runId && runId !== id)) continue;
        const start = String(run.checkIn || "");
        if (!monthOf(start)) continue;
        const time = Date.parse(`${start}T00:00:00Z`);
        if (!Number.isFinite(time)) continue;
        const days = Number(run.bookingRangeDays);
        // Missing span does not invent 31 days. Actual rows above remain primary.
        const span = Number.isSafeInteger(days) && days > 0 && days <= 366 ? days : 1;
        for (let i = 0; i < span; i++) add(company.companyId, new Date(time + i * 86400000).toISOString().slice(0, 10), id);
      }
    }
    return [...byCompany].map(([companyId, months]) => ({ companyId, months: [...months].sort() })).sort((a, b) => a.companyId.localeCompare(b.companyId));
  };
}
module.exports = { createCompanyIntegratedTargets };
