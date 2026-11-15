"use strict";
// Same request pair, membership and privacy projection as the full oracle.
// Only the acquisition adapter changes; monthly arithmetic is unmodified.
const crypto = require("node:crypto");
const { monthlyReportKeywordMembership, buildMonthlyReportSnapshot } = require("./monthly_reports.cjs");
const { previousMonthlyReportRequest } = require("./monthly_report_comparison.cjs");
const { publicSource, snapshotCore } = require("../reconstruct_keyword_monthly_source_copy.cjs");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
const fingerprint = v => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
async function normalizePair({ wiring, keyword, month, cutoffDate, capturedAt, checkpoint = async () => {} }) {
  const current = { type: "keyword", targetId: keyword, month, cutoffDate }, requests = [previousMonthlyReportRequest(current), current];
  const months = new Set(requests.map(r => r.month)), source = { companies: [], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {}, monthlySourceMetadata: {} };
  const companies = new Map(), runs = new Map(), ranks = new Set(), records = [], removed = {};
  for (const request of requests) {
    await checkpoint();
    const full = await wiring.sources.loadSources(request, { includeContext: false, priority: "foreground" });
    const runMap = new Map(full.runs.map(r => [String(r.id || r.runId), r]));
    const rowKeyword = row => String(row.keyword || runMap.get(String(row.runId || ""))?.keyword || "");
    const inScope = { ...full, observations: full.observations.filter(row => rowKeyword(row) === keyword),
      rankObservations: (full.rankObservations || []).filter(row => {
        const time = Date.parse(row.collectedAt || runMap.get(String(row.runId))?.collectedAt);
        return rowKeyword(row) === keyword && Number.isFinite(time) && months.has(new Date(time + 9 * 3600000).toISOString().slice(0, 7));
      }), savedProductRecoveries: (full.savedProductRecoveries || []).filter(entry => rowKeyword(entry.row) === keyword) };
    const membership = monthlyReportKeywordMembership(request, inScope); inScope.companies = full.companies.filter(c => membership.members.has(c.companyId));
    const ids = new Set([...inScope.observations, ...inScope.rankObservations, ...inScope.savedProductRecoveries.map(e => e.row)].map(r => String(r.runId || "")));
    inScope.runs = full.runs.filter(r => ids.has(String(r.id || r.runId)) || r.keyword === keyword);
    const safe = publicSource(inScope, removed), expected = snapshotCore(buildMonthlyReportSnapshot(request, full, capturedAt)), actual = snapshotCore(buildMonthlyReportSnapshot(request, safe, capturedAt));
    H.need(fingerprint(expected) === fingerprint(actual), "KEYWORD_INCREMENTAL_PUBLIC_SOURCE_PARITY_FAILED");
    for (const row of safe.companies) companies.set(row.companyId, row); for (const row of safe.runs) runs.set(row.id || row.runId, row);
    source.observations.push(...safe.observations); source.savedProductRecoveries.push(...safe.savedProductRecoveries);
    for (const row of safe.rankObservations) { const id = fingerprint(row); if (!ranks.has(id)) { ranks.add(id); source.rankObservations.push(row); } }
    source.monthlySourceMetadata[request.month] = { warnings: safe.warnings || [], sourceDiagnostics: safe.sourceDiagnostics || {}, globalWarnings: safe.globalWarnings || [], globalDiagnostics: safe.globalDiagnostics || {} };
    if (safe.specialDays) source.specialDays = safe.specialDays;
    records.push({ request, sourceFingerprint: fingerprint(safe), snapshotFingerprint: fingerprint(actual),
      counts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(k => [k, (safe[k] || []).length])) });
  }
  source.companies = [...companies.values()]; source.runs = [...runs.values()];
  H.need(source.observations.length <= 50000 && source.rankObservations.length <= 50000 && source.savedProductRecoveries.length <= 50000, "KEYWORD_INCREMENTAL_ROWS_BOUND");
  const bytes = Buffer.from(JSON.stringify(source)); H.need(bytes.length <= 64 * 1024 * 1024, "KEYWORD_INCREMENTAL_SOURCE_BOUND");
  return { source, bytes, inputSha256: H.hash(bytes), inputBytes: bytes.length, records, removed,
    provenance: { inputSha256: H.hash(bytes), inputBytes: bytes.length, copiedAt: capturedAt, observationScope: "normalized_multirun", normalizationCutoffs: Object.fromEntries(requests.map(r => [r.month, r.cutoffDate])) } };
}
module.exports = { normalizePair, fingerprint };
