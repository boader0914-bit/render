"use strict";
// A derived, bounded review of formerly unresolved raw history. Canonical
// saved-product rows keep precedence; original files and measurements are never
// edited here. The caller applies any returned recovery through its existing
// projection and quality gates before publishing the source.
const crypto = require("node:crypto");
const IDENTITY_REVIEW_VERSION = "monthly-observation-identity-review-v1";
const MAX_ROWS = 100000;
const SHA = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const rowHash = row => hash(JSON.stringify(row));
function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
    || !date(value.slice(0, 10))) return null;
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
}
function date(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value)
    && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function observationKey(row, companyId) {
  const stay = row.stayDate || row.date;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(row.runId || "") || !date(stay)
    || !["lodging", "dayuse"].includes(row.productType) || instant(row.collectedAt) === null) return null;
  return `${companyId}|${row.runId}|${row.productType}|${stay}`;
}
function identityRecordInKeywordScope(row, run, request) {
  if (!run || request.type !== "keyword" || String(row.keyword || run.keyword || "") !== request.targetId) return false;
  const quality = String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown").toLowerCase();
  if (!["complete", "reused", "partial"].includes(quality) || !row.collectedAt && run.collectedAtSource === "filesystem") return false;
  const time = instant(row.collectedAt || run.collectedAt); if (time === null) return false;
  const collectedDay = new Date(time + 9 * 3600000).toISOString().slice(0, 10); if (collectedDay > request.cutoffDate) return false;
  const stay = row.stayDate || row.date, type = row.productType === "day-use" ? "dayuse" : row.productType;
  const inventory = date(stay) && stay.startsWith(request.month + "-") && collectedDay <= stay
    && ["lodging", "dayuse"].includes(type) && Number(row.inventoryEvidenceVersion ?? row.evidenceVersion) >= 3;
  const rank = row.rank === null || row.rank === undefined || row.rank === "" || typeof row.rank === "boolean" ? null : Number(row.rank);
  const ranked = collectedDay.startsWith(request.month + "-") && Number.isInteger(rank) && rank >= 1;
  return inventory || ranked;
}
async function reviewMonthlyUnmatchedIdentityRows({ records, observations, origins = new Map(), resolver,
  runs = new Map(), blockedCompanyIds = new Set(), checkpoint = async () => {} }) {
  if (!Array.isArray(records) || records.length > MAX_ROWS || !(observations instanceof Map) || !(origins instanceof Map)
    || !(runs instanceof Map) || !(blockedCompanyIds instanceof Set) || typeof resolver?.resolve !== "function"
    || !SHA.test(resolver.catalogDigest || "") || typeof checkpoint !== "function") throw TypeError("Invalid bounded identity review input");
  const decisions = new Map(), groups = new Map(), recoveries = [], fulfilledRecords = new Set();
  const decide = (record, category, companyId, reasonCode, counterpart = null, origin = null) => {
    decisions.set(record, { category, companyId, reasonCode, counterpartSha256: counterpart ? rowHash(counterpart) : null, origin });
    if (category !== "unresolved") fulfilledRecords.add(record);
  };
  for (let index = 0; index < records.length; index++) {
    if (index % 128 === 0) await checkpoint();
    const record = records[index], row = record?.row;
    if (!row || typeof row !== "object" || Array.isArray(row) || decisions.has(record)) throw TypeError("Invalid identity review record");
    const identity = resolver.resolve(row);
    if (identity.status !== "resolved") { decide(record, "unresolved", null, identity.reasonCode || "IDENTITY_NO_STRONG_ID"); continue; }
    const companyId = identity.companyId, key = observationKey(row, companyId), run = runs.get(String(row.runId || ""));
    if (blockedCompanyIds.has(companyId)) { decide(record, "unresolved", companyId, "IDENTITY_AMBIGUOUS_PLACE_ID"); continue; }
    if (!key) { decide(record, "unresolved", companyId, "ROW_GRAIN_INVALID"); continue; }
    if (!run || row.keyword && run.keyword && row.keyword !== run.keyword) { decide(record, "unresolved", companyId, "RUN_SCOPE_CONFLICT"); continue; }
    const existing = observations.get(key);
    if (existing) {
      if (instant(existing.collectedAt) !== instant(row.collectedAt)) { decide(record, "unresolved", companyId, "COUNTERPART_TIME_MISMATCH"); continue; }
      // A canonical ID is not a provider witness to itself. Provenance is
      // supplied privately by the current saved-run producer, never trusted
      // from a persisted readOnlyRecalculated boolean in a raw history row.
      const providerOnly = { ...existing }; delete providerOnly.companyKey; delete providerOnly.companyId;
      const other = resolver.resolve(providerOnly), origin = origins.get(key);
      if (origin !== "saved_run_recalculation" && !(other.status === "resolved" && other.companyId === companyId)) {
        decide(record, "unresolved", companyId, "COUNTERPART_PROVENANCE_UNVERIFIED"); continue;
      }
      decide(record, "alreadyRepresented", companyId, null, existing, origin || "recorded_provider_id"); continue;
    }
    const quality = String(typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status || "unknown");
    if (!["complete", "reused", "partial"].includes(quality.toLowerCase())) { decide(record, "unresolved", companyId, "RUN_QUALITY_UNVERIFIED"); continue; }
    const list = groups.get(key) || []; list.push({ record, companyId, row, fingerprint: rowHash(row) }); groups.set(key, list);
  }
  let groupIndex = 0;
  for (const list of groups.values()) {
    if (groupIndex++ % 128 === 0) await checkpoint();
    // Do not choose between contradictory historical versions just because
    // they share an ID, run and date. Identical physical duplicates collapse.
    if (new Set(list.map(value => value.fingerprint)).size !== 1) {
      for (const value of list) decide(value.record, "unresolved", value.companyId, "CANDIDATE_ROWS_CONFLICT");
      continue;
    }
    const [first, ...duplicates] = list;
    const row = { ...first.row, companyKey: first.companyId, companyId: first.companyId };
    recoveries.push({ record: first.record, companyId: first.companyId, row });
    decide(first.record, "recovered", first.companyId, null, row, "recorded_provider_id");
    for (const duplicate of duplicates) decide(duplicate.record, "alreadyRepresented", duplicate.companyId, null, row, "identical_raw_duplicate");
  }
  const summary = { schemaVersion: 1, basis: "raw_unresolved_identity_rows", totalRows: records.length,
    alreadyRepresentedRows: 0, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {}, evidenceDigest: "", catalogDigest: resolver.catalogDigest };
  const digest = crypto.createHash("sha256").update(JSON.stringify([IDENTITY_REVIEW_VERSION, resolver.catalogDigest]));
  for (let index = 0; index < records.length; index++) {
    if (index % 128 === 0) await checkpoint();
    const record = records[index], decision = decisions.get(record); if (!decision) throw TypeError("Identity review did not classify every record");
    summary[decision.category + "Rows"]++;
    if (decision.category === "unresolved") summary.reasonCounts[decision.reasonCode] = (summary.reasonCounts[decision.reasonCode] || 0) + 1;
    digest.update(JSON.stringify([index, rowHash(record.row), decision]) + "\n");
  }
  summary.evidenceDigest = digest.digest("hex");
  return { identityReview: summary, fulfilledRecords, recoveries };
}
module.exports = { reviewMonthlyUnmatchedIdentityRows, IDENTITY_REVIEW_VERSION, observationKey, identityRecordInKeywordScope, MAX_ROWS };
