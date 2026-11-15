"use strict";

// A journal-only view. Linking an exact completed event neither changes the old
// record nor proves which observations are selected by the current publication.
const crypto = require("node:crypto");
const STATES = Object.freeze(["queued", "deferred", "running", "complete", "needs_verification"]);
const REVIEW_STATES = new Set(STATES.filter(state => state !== "complete"));
const SHA = /^[a-f0-9]{64}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/, VERSION = /^[A-Za-z0-9_.-]{1,100}$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const iso = value => typeof value === "string" && /^20\d\d-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const counts = () => Object.fromEntries(STATES.map(state => [state, 0]));
const reason = value => value === null ? null : typeof value === "string" && /^[A-Z][A-Z0-9_]{1,119}$/.test(value) ? value : "UNKNOWN";

function identity(row) {
  const i = row?.intent;
  if (!plain(row) || row.schemaVersion !== 1 || !SHA.test(row.jobId || "") || !plain(i)
    || Object.keys(i).length !== 6 || !["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "scope", "refreshVersion"].every(key => Object.hasOwn(i, key))
    || !RUN.test(i.runId || "") || !text(i.keyword, 300) || !SHA.test(i.manifestSha256 || "") || !text(i.scope, 300)
    || !VERSION.test(i.refreshVersion || "") || !(i.scheduleOccurrenceId === null || RUN.test(i.scheduleOccurrenceId || ""))
    || row.jobId !== hash([i.refreshVersion, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])) return null;
  return { version: i.refreshVersion, key: JSON.stringify([i.keyword, i.runId, i.manifestSha256, i.scheduleOccurrenceId, i.scope]) };
}
function completed(row) {
  const r = row?.result;
  return row.status === "complete" && iso(row.finishedAt) && plain(r) && ["published", "unchanged", "complete"].includes(r.status)
    && SHA.test(r.pointerSha256 || "") && (r.providerCalls === undefined || r.providerCalls === 0)
    && (r.networkAttempted === undefined || r.networkAttempted === false);
}
function ordered(groups) {
  return [...groups.values()].sort((a, b) => JSON.stringify([a.version || "", a.status, a.reasonCode]).localeCompare(JSON.stringify([b.version || "", b.status, b.reasonCode])));
}

function reviewHistoricalJobs(rows, currentVersion, { allRowsCoverage = false } = {}) {
  if (!Array.isArray(rows) || rows.length > 4096 || !VERSION.test(currentVersion || "")) throw TypeError("Invalid journal review input");
  const out = { schemaVersion: 1, readOnly: true, allRowsCoverage: allRowsCoverage === true, rowsExamined: rows.length,
    invalidRows: 0, historicalRows: 0, reviewedRows: 0, sameEventLaterCompleted: 0, priorExactComplete: 0, notCovered: 0, unknown: 0,
    currentVersionCounts: counts(), historicalCountsByVersion: {}, currentVersionReasonCounts: [], groups: [],
    originalJournalRowsChanged: false, retryAuthorized: false, currentScopeFreshnessVerified: false };
  const completedByEvent = new Map(), invalidCompleted = new Set(), rowsWithIdentity = [], currentReasons = new Map(), groups = new Map(), historicalCounts = new Map();
  for (const row of rows) {
    const id = identity(row), validState = STATES.includes(row?.status);
    if (!id || !validState) { out.invalidRows++; continue; }
    rowsWithIdentity.push({ row, id });
    if (id.version === currentVersion) {
      out.currentVersionCounts[row.status]++;
      const k = JSON.stringify([row.status, reason(row.reasonCode)]);
      if (!currentReasons.has(k)) currentReasons.set(k, { status: row.status, reasonCode: reason(row.reasonCode), count: 0 });
      currentReasons.get(k).count++;
    } else {
      out.historicalRows++;
      if (!historicalCounts.has(id.version)) historicalCounts.set(id.version, counts());
      historicalCounts.get(id.version)[row.status]++;
    }
    if (row.status !== "complete") continue;
    if (!completed(row)) { invalidCompleted.add(id.key); continue; }
    if (!completedByEvent.has(id.key)) completedByEvent.set(id.key, []);
    completedByEvent.get(id.key).push({ version: id.version, finishedAt: Date.parse(row.finishedAt) });
  }
  for (const { row, id } of rowsWithIdentity) {
    if (id.version === currentVersion || !REVIEW_STATES.has(row.status)) continue;
    const k = JSON.stringify([id.version, row.status, reason(row.reasonCode)]);
    if (!groups.has(k)) groups.set(k, { version: id.version, status: row.status, reasonCode: reason(row.reasonCode), count: 0,
      sameEventLaterCompleted: 0, priorExactComplete: 0, notCovered: 0, unknown: 0 });
    const group = groups.get(k); group.count++; out.reviewedRows++;
    const anchor = row.finishedAt === null ? row.updatedAt : row.finishedAt;
    const matches = (completedByEvent.get(id.key) || []).filter(candidate => candidate.version !== id.version);
    let disposition;
    if (!iso(anchor)) disposition = "unknown";
    else if (matches.some(candidate => candidate.finishedAt >= Date.parse(anchor))) disposition = "sameEventLaterCompleted";
    else if (matches.length) disposition = "priorExactComplete";
    else disposition = invalidCompleted.has(id.key) || out.invalidRows > 0 || !out.allRowsCoverage ? "unknown" : "notCovered";
    group[disposition]++; out[disposition]++;
  }
  out.currentVersionReasonCounts = ordered(currentReasons);
  out.historicalCountsByVersion = Object.fromEntries([...historicalCounts].sort(([a], [b]) => a.localeCompare(b)));
  out.groups = ordered(groups);
  return out;
}

module.exports = { reviewHistoricalJobs };
