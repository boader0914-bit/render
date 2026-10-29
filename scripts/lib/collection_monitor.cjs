"use strict";

// Projections only. These functions perform no filesystem, broker, scheduler or
// network operations and never turn missing evidence into a successful crawl.
const { sanitizeCollectionQuality } = require("./collection_diagnostics.cjs");
const DAY_MS = 86400000;
const validDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value >= "2000-01-01" && value <= "2099-12-31"
  && Number.isFinite(Date.parse(value + "T00:00:00Z"))
  && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const addDays = (value, count) => new Date(Date.parse(value + "T00:00:00Z") + count * DAY_MS).toISOString().slice(0, 10);
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value) ? value : null;
const code = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(value) ? value : null;
const iso = value => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) : "";
const STATES = new Set(["queued", "waiting", "pending", "running", "complete", "completed", "reused", "partial", "failed", "blocked", "missed", "paused", "uncertain", "interrupted", "cancelled", "canceled"]);

function monitorRange(query = {}, now = new Date()) {
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !["from", "to"].includes(key))) {
    throw Object.assign(new Error("COLLECTION_MONITOR_RANGE_INVALID"), { code: "COLLECTION_MONITOR_RANGE_INVALID", statusCode: 400 });
  }
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) throw new TypeError("Invalid monitor clock");
  const today = new Date(at.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const monday = addDays(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  const from = query.from === undefined ? query.to === undefined ? monday : validDay(query.to) ? addDays(query.to, -6) : null : query.from;
  const to = query.to === undefined ? validDay(from) ? addDays(from, 6) : null : query.to;
  if (!validDay(from) || !validDay(to) || from > to || Date.parse(to) - Date.parse(from) > 6 * DAY_MS) {
    throw Object.assign(new Error("COLLECTION_MONITOR_RANGE_INVALID"), { code: "COLLECTION_MONITOR_RANGE_INVALID", statusCode: 400 });
  }
  return { from, to, today, generatedAt: at.toISOString(), timezone: "Asia/Seoul" };
}

function monitorItem(value) {
  const conditions = {};
  const source = value.conditions || {};
  for (const key of ["checkIn", "checkOut"]) if (validDay(source[key])) conditions[key] = source[key];
  for (const key of ["bookingDays", "bookingRangeDays", "adults", "bookingRangePlaceLimit"]) {
    if (Number.isSafeInteger(source[key]) && source[key] > 0 && source[key] <= 366) conditions[key] = source[key];
  }
  for (const [key, choices] of Object.entries({ collectionMode: ["fast", "precision"], collectionPurpose: ["basic_db", "revenue_detail"],
    productMode: ["all", "lodging", "campnic"], dayUseMode: ["inspect", "lodging_only", "detail"], searchMode: ["keyword", "company"] })) {
    if (choices.includes(source[key])) conditions[key] = source[key];
  }
  if (typeof source.detailRankRanges === "string" && source.detailRankRanges.length <= 150 && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(source.detailRankRanges)) conditions.detailRankRanges = source.detailRankRanges;
  return { id: id(value.id), day: validDay(value.day || value.date) ? value.day || value.date : null,
    index: Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : null,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null,
    workerKey: ["web", "manual"].includes(value.workerKey) ? value.workerKey : "unknown", keyword: text(value.keyword),
    scheduledAt: iso(value.scheduledAt), notBeforeAt: iso(value.notBeforeAt), status: STATES.has(value.status) ? value.status : "unknown",
    acceptedAt: iso(value.acceptedAt), startedAt: iso(value.startedAt), finishedAt: iso(value.finishedAt),
    errorCode: code(value.errorCode), runId: id(value.runId), collectionQuality: sanitizeCollectionQuality(value.collectionQuality),
    conditions, projected: value.projected === true, source: value.projected === true ? "projection" : "stored_rotation",
    planKind: ["regular", "one_day_trial"].includes(value.planKind) ? value.planKind : null,
    ...(id(value.trialId) ? { trialId: id(value.trialId) } : {}) };
}

function monitorPostprocessItem(job) {
  if (!job) return null;
  const state = ["held", "queued", "running", "complete", "failed"].includes(job.status || job.state) ? job.status || job.state : "unavailable";
  return { runId: id(job.runId), scheduleOccurrenceId: id(job.scheduleOccurrenceId ?? job.context?.scheduleOccurrenceId), state,
    createdAt: iso(job.createdAt), updatedAt: iso(job.updatedAt), startedAt: iso(job.startedAt), finishedAt: iso(job.finishedAt),
    errorCode: code(job.lastErrorCode), admissionErrorCode: code(job.admissionErrorCode),
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : null,
    admissionDeferrals: Number.isSafeInteger(job.admissionDeferrals) && job.admissionDeferrals >= 0 ? job.admissionDeferrals : null };
}

function attachMonitorPostprocess(snapshot, postprocess) {
  const rows = Array.isArray(postprocess?.items) ? postprocess.items : [];
  const index = new Map(rows.map(row => [row.runId, row]));
  return { ...snapshot, postprocessCoverage: { available: postprocess?.available === true, source: "memory",
    missingRunIds: Array.isArray(postprocess?.missingRunIds) ? [...postprocess.missingRunIds] : [], errorCode: code(postprocess?.errorCode) },
    items: (snapshot.items || []).map(item => {
      if (item.projected || !item.runId) return item;
      const row = index.get(item.runId);
      if (postprocess?.available !== true || !row) return { ...item, postprocess: { state: "unavailable", bindingVerified: false,
        errorCode: postprocess?.available !== true ? code(postprocess?.errorCode) || "COLLECTION_MONITOR_POSTPROCESS_UNAVAILABLE" : "COLLECTION_MONITOR_POSTPROCESS_NOT_RETAINED" } };
      if (row.runId !== item.runId || row.scheduleOccurrenceId !== item.id) return { ...item,
        postprocess: { state: "unavailable", bindingVerified: false, errorCode: "COLLECTION_MONITOR_POSTPROCESS_BINDING_MISMATCH" } };
      return { ...item, postprocess: { ...row, bindingVerified: true } };
    }) };
}

module.exports = { monitorRange, monitorItem, monitorPostprocessItem, attachMonitorPostprocess };
