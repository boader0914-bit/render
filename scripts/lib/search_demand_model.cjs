"use strict";

// Pure normalization and saved-data presentation. No configuration, provider or I/O.
const crypto = require("node:crypto");
const MAX_ROWS = 50000, MAX_TREND_ROWS = 2880;
const SNAPSHOT_ID = /^sd_[a-f0-9]{64}$/;
const KEYWORD_ID = /^kw_[a-f0-9]{64}$/;
const WINDOW_ID = /^tw_[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const object = v => Boolean(v && typeof v === "object" && !Array.isArray(v));
function problem(code = "SEARCH_DEMAND_INVALID_REQUEST", statusCode = 400) {
  return Object.assign(new Error("검색 수요 자료의 조회 조건이나 저장 상태를 확인해 주세요."), { code, statusCode });
}
function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const hash = value => crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
function normalizeKeyword(value) {
  if (typeof value !== "string") throw problem();
  const keyword = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!keyword || keyword.length > 120 || /[\x00-\x1f\x7f]/u.test(keyword)) throw problem();
  const normalized = keyword.replace(/\s+/gu, "").toLowerCase();
  return { keywordId: "kw_" + hash(normalized), keyword, normalized };
}
function dateValid(value) {
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
    && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function monthValid(value) { return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value); }
function isoValid(value) { return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function dayFromIso(value) { if (!isoValid(value)) throw problem("SEARCH_DEMAND_TIME_INVALID"); return new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10); }
function normalizeTime(value) {
  if (typeof value !== "string" || value.length > 40 || !dateValid(value.slice(0, 10)) || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw problem("SEARCH_DEMAND_TIME_INVALID");
  return new Date(value).toISOString();
}
function parseCount(raw) {
  const unknown = () => ({ state: "unknown", value: null, raw: null, lowerBound: null, upperBoundExclusive: null });
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0
    ? { state: "number", value: raw, raw, lowerBound: raw, upperBoundExclusive: null } : unknown();
  if (typeof raw !== "string" || raw.length > 64) return unknown();
  const text = raw.trim();
  if (/^<\s*10$/.test(text)) return { state: "range", value: null, raw, lowerBound: 0, upperBoundExclusive: 10 };
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) return unknown();
  const value = Number(text.replace(/,/g, ""));
  return Number.isSafeInteger(value) && value >= 0 ? { state: "number", value, raw, lowerBound: value, upperBoundExclusive: null } : unknown();
}
function sumCounts(a, b) {
  if (a.state === "unknown" || b.state === "unknown") return parseCount(null);
  if (a.state === "number" && b.state === "number") return parseCount(a.value + b.value);
  const lowerBound = a.lowerBound + b.lowerBound;
  const upperBoundExclusive = (a.state === "range" ? a.upperBoundExclusive : a.value) + (b.state === "range" ? b.upperBoundExclusive : b.value);
  return Number.isSafeInteger(lowerBound) && Number.isSafeInteger(upperBoundExclusive)
    ? { state: "range", value: null, raw: null, lowerBound, upperBoundExclusive } : parseCount(null);
}
function countIdentity(count) { return [count.state, count.value, count.lowerBound, count.upperBoundExclusive]; }
function countStatus(pc, mobile) { return pc.state === "unknown" || mobile.state === "unknown" ? "partial" : pc.state === "range" || mobile.state === "range" ? "range" : "ready"; }
function baseSnapshot(input, provider) {
  if (!object(input) || !SCOPE.test(input.scopeId || "")) throw problem("SEARCH_DEMAND_SCOPE_INVALID");
  const keyword = normalizeKeyword(input.keyword), observedAt = normalizeTime(input.observedAt);
  if (input.requestId !== undefined && !SCOPE.test(input.requestId)) throw problem();
  if (input.connectionProvider !== undefined && !["developers", "ncp_apihub"].includes(input.connectionProvider)) throw problem();
  return { schemaVersion: 1, provider, ...keyword, scopeId: input.scopeId, observedAt, day: dayFromIso(observedAt),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.connectionProvider === undefined ? {} : { connectionProvider: input.connectionProvider }) };
}
function seal(body) { const contentSha256 = hash(body); return { ...body, snapshotId: "sd_" + contentSha256, contentSha256 }; }
function normalizeSearchAdSnapshot(input) {
  const base = baseSnapshot(input, "searchad");
  if (!Array.isArray(input.keywordList) || input.keywordList.length > MAX_ROWS) throw problem("SEARCH_DEMAND_RESPONSE_BOUNDS");
  const rows = [], invalidRows = [], byKey = new Map();
  input.keywordList.forEach((row, sourceIndex) => {
    let identity;
    try { if (!object(row)) throw problem(); identity = normalizeKeyword(row.relKeyword); } catch { invalidRows.push({ sourceIndex, reasonCode: "KEYWORD_INVALID" }); return; }
    const monthlyPc = parseCount(row.monthlyPcQcCnt), monthlyMobile = parseCount(row.monthlyMobileQcCnt);
    const normalized = { ...identity, sourceIndex, isAnchor: identity.keywordId === base.keywordId, monthlyPc, monthlyMobile,
      total: sumCounts(monthlyPc, monthlyMobile), status: countStatus(monthlyPc, monthlyMobile) };
    rows.push(normalized);
    const list = byKey.get(identity.keywordId) || []; list.push(normalized); byKey.set(identity.keywordId, list);
  });
  const observations = [...byKey.values()].map(list => {
    const first = list[0];
    const conflicting = list.some(row => stableStringify([countIdentity(row.monthlyPc), countIdentity(row.monthlyMobile)]) !== stableStringify([countIdentity(first.monthlyPc), countIdentity(first.monthlyMobile)]));
    const { sourceIndex, ...rest } = first;
    return { ...rest, ...(conflicting ? { monthlyPc: parseCount(null), monthlyMobile: parseCount(null), total: parseCount(null), status: "partial" } : {}),
      conflicting, sourceIndices: list.map(row => row.sourceIndex) };
  });
  const anchor = observations.find(row => row.isAnchor) || null;
  const counts = { returnedRows: input.keywordList.length, validRows: rows.length, invalidRows: invalidRows.length,
    duplicateRows: rows.length - observations.length, conflictingKeys: observations.filter(row => row.conflicting).length,
    uniqueRows: observations.length, partialKeys: observations.filter(row => row.status === "partial").length };
  counts.reconciled = counts.returnedRows === counts.validRows + counts.invalidRows && counts.validRows === counts.uniqueRows + counts.duplicateRows;
  return seal({ ...base, status: !anchor ? "missing" : anchor.status === "partial" || counts.invalidRows || counts.conflictingKeys ? "partial" : "ready",
    anchor, rows, observations, invalidRows, counts });
}
function monthsBetween(startDate, endDate) {
  const values = [], start = startDate.slice(0, 7), end = endDate.slice(0, 7);
  for (let month = start; month <= end;) {
    values.push(month + "-01"); if (values.length > 24) throw problem("SEARCH_DEMAND_PERIOD_BOUNDS");
    const [y, m] = month.split("-").map(Number); month = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  return values;
}
function normalizeTrendSnapshot(input) {
  const base = baseSnapshot(input, "datalab");
  if (!dateValid(input.startDate) || !dateValid(input.endDate) || input.startDate > input.endDate || input.timeUnit !== "month") throw problem("SEARCH_DEMAND_PERIOD_INVALID");
  if (!Array.isArray(input.results) || input.results.length > 1) throw problem("SEARCH_DEMAND_TREND_RESPONSE_INVALID");
  const expected = monthsBetween(input.startDate, input.endDate), allowed = new Set(expected), group = input.results[0];
  const queryKeywords = group?.keywords === undefined ? [base.keyword] : group.keywords;
  if (!Array.isArray(queryKeywords) || queryKeywords.length < 1 || queryKeywords.length > 20) throw problem("SEARCH_DEMAND_TREND_KEYWORDS_INVALID");
  const keywords = queryKeywords.map(value => normalizeKeyword(value).keyword);
  if (group && (!object(group) || normalizeKeyword(group.title).keywordId !== base.keywordId || !Array.isArray(group.data))) throw problem("SEARCH_DEMAND_TREND_KEYWORD_MISMATCH");
  const data = group?.data || [];
  if (data.length > MAX_TREND_ROWS) throw problem("SEARCH_DEMAND_RESPONSE_BOUNDS");
  const found = new Map(), invalidRows = [];
  for (const [sourceIndex, row] of data.entries()) {
    if (!object(row) || !dateValid(row.period) || !allowed.has(row.period)) { invalidRows.push({ sourceIndex, reasonCode: "PERIOD_MISMATCH" }); continue; }
    const raw = row.ratio;
    const ratio = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) { invalidRows.push({ sourceIndex, reasonCode: "RATIO_INVALID" }); continue; }
    const list = found.get(row.period) || []; list.push(ratio); found.set(row.period, list);
  }
  const conflicting = [...found.entries()].filter(([, values]) => values.some(value => value !== values[0])).map(([period]) => period);
  const series = expected.map(period => {
    const values = found.get(period), good = values?.length && !conflicting.includes(period);
    return { period, ratio: good ? values[0] : null, state: good ? "observed" : "missing" };
  });
  const observedMonths = series.filter(row => row.state === "observed").length;
  const coverage = { expectedMonths: expected.length, observedMonths, missingMonths: series.filter(row => row.state === "missing").map(row => row.period.slice(0, 7)) };
  const validRows = [...found.values()].reduce((sum, values) => sum + values.length, 0);
  const counts = { returnedRows: data.length, validRows, invalidRows: invalidRows.length, duplicateRows: validRows - found.size,
    conflictingKeys: conflicting.length, uniqueRows: found.size, reconciled: data.length === validRows + invalidRows.length };
  const window = { provider: "datalab", keywordId: base.keywordId, keywords, startDate: input.startDate, endDate: input.endDate, timeUnit: "month" };
  return seal({ ...base, status: observedMonths === 0 ? "missing" : observedMonths !== expected.length || invalidRows.length || conflicting.length ? "partial" : "ready",
    startDate: input.startDate, endDate: input.endDate, timeUnit: "month", queryKeywords: keywords, windowId: "tw_" + hash(window), series, coverage, invalidRows, counts });
}
function validateSnapshot(snapshot) {
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || !["searchad", "datalab"].includes(snapshot.provider) || !SNAPSHOT_ID.test(snapshot.snapshotId || "")
    || !KEYWORD_ID.test(snapshot.keywordId || "") || !SCOPE.test(snapshot.scopeId || "") || !isoValid(snapshot.observedAt) || snapshot.day !== dayFromIso(snapshot.observedAt)
    || !["ready", "partial", "missing"].includes(snapshot.status)) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  const identity = normalizeKeyword(snapshot.keyword);
  if (identity.keywordId !== snapshot.keywordId || identity.normalized !== snapshot.normalized) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  const { snapshotId, contentSha256, ...body } = snapshot;
  if (contentSha256 !== hash(body) || snapshotId !== "sd_" + contentSha256) throw problem("SEARCH_DEMAND_SNAPSHOT_HASH_MISMATCH", 503);
  const commonFields = ["schemaVersion", "provider", "keywordId", "keyword", "normalized", "scopeId", "observedAt", "day", "requestId", "connectionProvider", "status", "invalidRows", "counts", "snapshotId", "contentSha256"];
  const extraFields = snapshot.provider === "searchad" ? ["anchor", "rows", "observations"] : ["startDate", "endDate", "timeUnit", "queryKeywords", "windowId", "series", "coverage"];
  if (Object.keys(snapshot).some(key => !commonFields.includes(key) && !extraFields.includes(key))
    || snapshot.requestId !== undefined && !SCOPE.test(snapshot.requestId) || snapshot.connectionProvider !== undefined && !["developers", "ncp_apihub"].includes(snapshot.connectionProvider)) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  const counts = snapshot.counts, countKeys = ["returnedRows", "validRows", "invalidRows", "duplicateRows", "conflictingKeys", "uniqueRows"];
  if (!object(counts) || countKeys.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > MAX_ROWS)
    || Object.keys(counts).some(key => ![...countKeys, "partialKeys", "reconciled"].includes(key)) || counts.reconciled !== true
    || counts.returnedRows !== counts.validRows + counts.invalidRows || counts.validRows !== counts.uniqueRows + counts.duplicateRows
    || counts.conflictingKeys > counts.uniqueRows || !Array.isArray(snapshot.invalidRows) || snapshot.invalidRows.length !== counts.invalidRows
    || snapshot.invalidRows.some(row => !object(row) || Object.keys(row).some(key => !["sourceIndex", "reasonCode"].includes(key)) || !Number.isSafeInteger(row.sourceIndex) || row.sourceIndex < 0 || row.sourceIndex >= counts.returnedRows
      || !["KEYWORD_INVALID", "PERIOD_MISMATCH", "RATIO_INVALID"].includes(row.reasonCode))) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  if (snapshot.provider === "searchad") {
    if (!Array.isArray(snapshot.rows) || !Array.isArray(snapshot.observations) || !Array.isArray(snapshot.invalidRows) || snapshot.rows.length > MAX_ROWS
      || !snapshot.counts?.reconciled || snapshot.counts.validRows !== snapshot.rows.length || snapshot.counts.uniqueRows !== snapshot.observations.length
      || snapshot.counts.returnedRows !== snapshot.rows.length + snapshot.invalidRows.length) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
    const sources = [...snapshot.invalidRows.map(row => row.sourceIndex)], byKey = new Map();
    for (const row of snapshot.rows) {
      if (!object(row) || Object.keys(row).some(key => !["keywordId", "keyword", "normalized", "sourceIndex", "isAnchor", "monthlyPc", "monthlyMobile", "total", "status"].includes(key))
        || !Number.isSafeInteger(row.sourceIndex) || row.sourceIndex < 0 || row.sourceIndex >= counts.returnedRows) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
      const identity = normalizeKeyword(row.keyword);
      if (row.keywordId !== identity.keywordId || row.normalized !== identity.normalized || row.isAnchor !== (row.keywordId === snapshot.keywordId)
        || !equalCount(row.monthlyPc) || !equalCount(row.monthlyMobile) || stableStringify(row.total) !== stableStringify(sumCounts(row.monthlyPc, row.monthlyMobile))
        || row.status !== countStatus(row.monthlyPc, row.monthlyMobile)) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
      sources.push(row.sourceIndex); const list = byKey.get(row.keywordId) || []; list.push(row); byKey.set(row.keywordId, list);
    }
    if (new Set(sources).size !== counts.returnedRows) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
    const expected = [...byKey.values()].map(list => {
      const { sourceIndex, ...first } = list[0];
      const conflicting = list.some(row => stableStringify([countIdentity(row.monthlyPc), countIdentity(row.monthlyMobile)]) !== stableStringify([countIdentity(first.monthlyPc), countIdentity(first.monthlyMobile)]));
      return { ...first, ...(conflicting ? { monthlyPc: parseCount(null), monthlyMobile: parseCount(null), total: parseCount(null), status: "partial" } : {}), conflicting, sourceIndices: list.map(row => row.sourceIndex) };
    });
    const anchor = expected.find(row => row.isAnchor) || null;
    const status = !anchor ? "missing" : anchor.status === "partial" || counts.invalidRows || counts.conflictingKeys ? "partial" : "ready";
    if (stableStringify(expected) !== stableStringify(snapshot.observations) || stableStringify(anchor) !== stableStringify(snapshot.anchor) || status !== snapshot.status
      || counts.conflictingKeys !== expected.filter(row => row.conflicting).length || counts.partialKeys !== expected.filter(row => row.status === "partial").length) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  } else if (!WINDOW_ID.test(snapshot.windowId || "") || !Array.isArray(snapshot.series) || snapshot.series.length > 24 || !snapshot.coverage
    || snapshot.coverage.expectedMonths !== snapshot.series.length || !snapshot.counts?.reconciled) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  else {
    if (!dateValid(snapshot.startDate) || !dateValid(snapshot.endDate) || snapshot.startDate > snapshot.endDate || snapshot.timeUnit !== "month"
      || !Array.isArray(snapshot.queryKeywords) || snapshot.queryKeywords.length < 1 || snapshot.queryKeywords.length > 20) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
    snapshot.queryKeywords.forEach(normalizeKeyword);
    const expected = monthsBetween(snapshot.startDate, snapshot.endDate);
    if (expected.length !== snapshot.series.length || snapshot.series.some((row, index) => !object(row) || Object.keys(row).some(key => !["period", "ratio", "state"].includes(key)) || row.period !== expected[index]
      || !["observed", "missing"].includes(row.state) || (row.state === "observed" ? typeof row.ratio !== "number" || !Number.isFinite(row.ratio) || row.ratio < 0 || row.ratio > 100 : row.ratio !== null))) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
    const observed = snapshot.series.filter(row => row.state === "observed").length, missing = snapshot.series.filter(row => row.state === "missing").map(row => row.period.slice(0, 7));
    const status = observed === 0 ? "missing" : observed !== expected.length || counts.invalidRows || counts.conflictingKeys ? "partial" : "ready";
    if (snapshot.status !== status || snapshot.coverage.observedMonths !== observed || stableStringify(snapshot.coverage.missingMonths) !== stableStringify(missing)
      || snapshot.windowId !== "tw_" + hash({ provider: "datalab", keywordId: snapshot.keywordId, keywords: snapshot.queryKeywords, startDate: snapshot.startDate, endDate: snapshot.endDate, timeUnit: "month" })) throw problem("SEARCH_DEMAND_SNAPSHOT_INVALID", 503);
  }
  return snapshot;
}
function equalCount(value) { return object(value) && stableStringify(value) === stableStringify(parseCount(value.raw)); }
function monthRange(month) { if (!monthValid(month)) throw problem(); const [y, m] = month.split("-").map(Number); return { from: month + "-01", to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; }
function daysBetween(from, to) {
  if (!dateValid(from) || !dateValid(to) || from > to) throw problem();
  const result = []; for (let time = Date.parse(from + "T00:00:00Z"); time <= Date.parse(to + "T00:00:00Z"); time += 86400000) {
    if (result.length >= 366) throw problem("SEARCH_DEMAND_DAY_BOUNDS"); result.push(new Date(time).toISOString().slice(0, 10));
  } return result;
}
function safeMetadata(snapshot) {
  return { schemaVersion: 1, provider: snapshot.provider, snapshotId: snapshot.snapshotId, keywordId: snapshot.keywordId, keyword: snapshot.keyword,
    day: snapshot.day, observedAt: snapshot.observedAt, status: snapshot.status, counts: clone(snapshot.counts),
    ...(snapshot.connectionProvider ? { connectionProvider: snapshot.connectionProvider } : {}),
    ...(snapshot.provider === "datalab" ? { startDate: snapshot.startDate, endDate: snapshot.endDate, windowId: snapshot.windowId } : {}) };
}
function publicRow(row) {
  if (!row) return null;
  return { keywordId: row.keywordId, keyword: row.keyword, normalized: row.normalized, isAnchor: Boolean(row.isAnchor),
    monthlyPc: clone(row.monthlyPc), monthlyMobile: clone(row.monthlyMobile), total: clone(row.total), status: row.status, conflicting: Boolean(row.conflicting) };
}
function normalizeSelection(input = {}, now = new Date()) {
  const identity = normalizeKeyword(input.keyword), day = input.day || dayFromIso(new Date(now).toISOString()), month = input.month || day.slice(0, 7);
  if (!dateValid(day) || !monthValid(month)) throw problem();
  const page = Number(input.page ?? 1), pageSize = Number(input.pageSize ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw problem();
  const sort = input.sort || "searchVolumeDesc";
  if (!["searchVolumeDesc", "searchVolumeAsc", "keyword", "keywordAsc", "mobileDesc", "pcDesc"].includes(sort)) throw problem();
  const search = String(input.search || "").trim(); if (search.length > 120 || /[\x00-\x1f\x7f]/.test(search)) throw problem();
  const relatedKeyword = input.relatedKeyword ? normalizeKeyword(input.relatedKeyword).keyword : "";
  return { ...identity, day, month, relatedKeyword, page, pageSize, sort, search };
}
function buildSearchDemandAnalysis({ selection: raw, searchSnapshot = null, trendSnapshot = null, dailyRows = [], history = [], historyTotal, now = new Date() } = {}) {
  const selection = normalizeSelection(raw, now);
  const anchor = searchSnapshot?.anchor || null;
  const stale = Boolean(searchSnapshot && searchSnapshot.day !== selection.day);
  const searchVolume = { status: !anchor ? "missing" : stale ? "stale" : anchor.status, anchor: publicRow(anchor),
    observedAt: searchSnapshot?.observedAt || "", day: searchSnapshot?.day || "", snapshotId: searchSnapshot?.snapshotId || "", exact: Boolean(anchor?.isAnchor), stale };
  const all = searchSnapshot?.observations || [], needle = selection.search.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const relatedRows = all.filter(row => !needle || row.normalized.includes(needle));
  const numeric = (row, field = "total") => row[field]?.state === "number" ? row[field].value : row[field]?.state === "range" ? row[field].lowerBound : -1;
  relatedRows.sort((a, b) => {
    if (["keyword", "keywordAsc"].includes(selection.sort)) return a.keyword.localeCompare(b.keyword, "ko");
    const field = selection.sort === "mobileDesc" ? "monthlyMobile" : selection.sort === "pcDesc" ? "monthlyPc" : "total";
    return (selection.sort === "searchVolumeAsc" ? numeric(a, field) - numeric(b, field) : numeric(b, field) - numeric(a, field)) || a.keyword.localeCompare(b.keyword, "ko");
  });
  const totalPages = Math.max(1, Math.ceil(relatedRows.length / selection.pageSize)), page = Math.min(selection.page, totalPages);
  selection.page = page;
  const range = monthRange(selection.month), dailyIdentity = normalizeKeyword(selection.relatedKeyword || selection.keyword);
  const rowsByDay = new Map(dailyRows.map(row => [row.day, row]));
  const daily = { keyword: dailyIdentity.keyword, keywordId: dailyIdentity.keywordId, ...range,
    rows: daysBetween(range.from, range.to).map(day => rowsByDay.get(day) || { day, observedAt: "", snapshotId: "", monthlyPc: parseCount(null), monthlyMobile: parseCount(null), total: parseCount(null), status: "missing" }) };
  daily.missingDaysCount = daily.rows.filter(row => row.status === "missing").length;
  const trend = trendSnapshot ? { status: trendSnapshot.status, snapshotId: trendSnapshot.snapshotId, keyword: trendSnapshot.keyword,
    observedAt: trendSnapshot.observedAt, startDate: trendSnapshot.startDate, endDate: trendSnapshot.endDate, timeUnit: trendSnapshot.timeUnit,
    windowId: trendSnapshot.windowId, series: clone(trendSnapshot.series), coverage: clone(trendSnapshot.coverage),
    ...(trendSnapshot.connectionProvider ? { connectionProvider: trendSnapshot.connectionProvider } : {}) }
    : { status: "missing", snapshotId: "", keyword: selection.keyword, observedAt: "", startDate: "", endDate: "", timeUnit: "month", windowId: "", series: [], coverage: { expectedMonths: 0, observedMonths: 0, missingMonths: [] } };
  return { schemaVersion: 1, selection, searchVolume, daily, trend,
    related: { status: !searchSnapshot ? "missing" : searchSnapshot.status, snapshotId: searchSnapshot?.snapshotId || "", observedAt: searchSnapshot?.observedAt || "",
      rows: relatedRows.slice((page - 1) * selection.pageSize, page * selection.pageSize).map(publicRow), total: relatedRows.length, page, pageSize: selection.pageSize, totalPages,
      counts: searchSnapshot ? clone(searchSnapshot.counts) : { returnedRows: null, validRows: null, invalidRows: null, duplicateRows: null, conflictingKeys: null, uniqueRows: null, reconciled: false } },
    history: { rows: history.map(row => safeMetadata(row)), total: historyTotal ?? history.length, limit: 100, truncated: (historyTotal ?? history.length) > history.length },
    limitations: ["검색량은 관측 시점의 월간 규모이며 일별 검색수 또는 달 전체 확정 합계가 아닙니다.", "기준어와 연관어 검색량은 겹칠 수 있어 시장 전체 합계로 더하지 않습니다.", "트렌드 지수는 같은 전체 조회창 안에서만 해석합니다."] };
}
module.exports = { normalizeKeyword, parseCount, sumCounts, normalizeSearchAdSnapshot, normalizeTrendSnapshot, validateSnapshot, buildSearchDemandAnalysis,
  normalizeSelection, safeMetadata, publicRow, stableStringify, hash, problem, dateValid, monthValid, isoValid, dayFromIso, daysBetween, monthRange,
  SNAPSHOT_ID, KEYWORD_ID, WINDOW_ID, MAX_ROWS };
