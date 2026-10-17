"use strict";

// Read-only restoration of geographic proof from an existing original response.
// A derived cache's requested region, normalized metrics or self-declared quality
// is never sufficient evidence. This module performs no network calls or writes.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "stored-tourism-spatial-evidence-v1";
const OPERATION_VERSION = "stored-tourism-operation-evidence-v1";
const OPERATION_KIND = "tourism-operation";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100000;
const MAX_MEMO_ENTRIES = 36; // Matches the largest existing history background build.
const CHECKS = Object.freeze(["safe_original_path", "original_semantic_sha256", "source_adapter_period",
  "raw_region_code_and_name", "complete_daily_categories", "no_conflicting_rows", "stored_metric_values"]);
const compact = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, "");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const condition = (value, reasonCode) => { if (!value) throw Object.assign(new Error(reasonCode), { reasonCode }); };
const diagnostic = (status, reasonCode = "") => ({ status, reasonCode, version: VERSION });
function failureCode(error) {
  if (error?.code === "ENOENT") return "VISITOR_ORIGINAL_RESPONSE_NOT_FOUND";
  return /^[A-Z0-9_]+$/.test(error?.reasonCode || "") ? error.reasonCode : "VISITOR_ORIGINAL_RESPONSE_UNREADABLE";
}

function createStoredTourismEvidenceRestorer(options = {}) {
  const tourismDataDir = path.resolve(options.tourismDataDir || "tourism_data");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const maxBytes = Math.min(MAX_BYTES, Math.max(1, Number(options.maxBytes) || MAX_BYTES));
  const maxRows = Math.min(MAX_ROWS, Math.max(1, Number(options.maxRows) || MAX_ROWS));
  const memo = new Map();
  // Raw JSON can be large. Serialize parsing across months, then retain only
  // compact per-region summaries. Concurrent requests share the same promise.
  let reading = Promise.resolve();
  const stats = { originalReads: 0, memoHits: 0, verifiedMonths: 0 };
  const operationStore = options.responseEvidenceStore || null;
  function memoized(key, operation) {
    if (memo.has(key)) { stats.memoHits++; return memo.get(key); }
    const promise = reading.catch(() => {}).then(operation);
    reading = promise.then(() => undefined, () => undefined);
    memo.set(key, promise);
    while (memo.size > MAX_MEMO_ENTRIES) memo.delete(memo.keys().next().value);
    return promise;
  }
  async function originalSummary({ snapshot, regionMap, range, adapter }) {
    const reference = snapshot.evidence;
    condition(reference?.status === "stored", "VISITOR_ORIGINAL_RESPONSE_NOT_STORED");
    condition(/^[a-f0-9]{64}$/.test(reference.sha256 || ""), "VISITOR_ORIGINAL_REFERENCE_INVALID");
    const evidenceId = `visitor-${range.yearMonth}-${reference.sha256.slice(0, 16)}`;
    const relativePath = `evidence/visitors/${evidenceId}.json`;
    condition(reference.evidenceId === evidenceId && reference.relativePath === relativePath,
      "VISITOR_ORIGINAL_REFERENCE_INVALID");
    const sourceRoot = await fs.realpath(tourismDataDir);
    const parent = await fs.realpath(path.join(tourismDataDir, "evidence", "visitors"));
    const filename = await fs.realpath(path.resolve(tourismDataDir, relativePath));
    condition(parent.startsWith(sourceRoot + path.sep) && path.dirname(filename) === parent, "VISITOR_ORIGINAL_PATH_INVALID");
    const stat = await fs.stat(filename);
    condition(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, "VISITOR_ORIGINAL_SIZE_INVALID");
    const mappingDigest = sha(JSON.stringify({ version: regionMap.version, regions: regionMap.regions }));
    const memoKey = `${filename}|${stat.ino}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${reference.sha256}|${reference.rowCount}|${adapter}|${range.yearMonth}|${range.expectedDays}|${range.startYmd}|${range.endYmd}|${mappingDigest}`;
    return memoized(memoKey, async () => {
      const before = await fs.stat(filename);
      const bytes = await fs.readFile(filename);
      stats.originalReads++;
      condition(bytes.length <= maxBytes, "VISITOR_ORIGINAL_SIZE_INVALID");
      const raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
      condition(sha(JSON.stringify(raw)) === reference.sha256, "VISITOR_ORIGINAL_HASH_MISMATCH");
      const rows = raw.response?.rows;
      condition(raw.schemaVersion === 1 && raw.source === "visitors" && raw.adapter === adapter
        && raw.yearMonth === range.yearMonth && raw.request?.operation === "locgoRegnVisitrDDList"
        && raw.request.requestGrain === "month_all_regions" && raw.request.startYmd === range.startYmd
        && raw.request.endYmd === range.endYmd, "VISITOR_ORIGINAL_IDENTITY_MISMATCH");
      condition(Array.isArray(rows) && rows.length > 0 && rows.length <= maxRows
        && raw.response.totalCount === rows.length && raw.response.receivedRowCount === rows.length
        && reference.rowCount === rows.length, "VISITOR_ORIGINAL_ROW_COUNT_INVALID");
      const regions = regionMap.regions || [];
      const byCode = new Map(), summaries = new Map();
      for (const region of regions) {
        const code = String(region.ktoSggCd || ""), name = compact(region.sigungu);
        const summary = { regionKey: region.regionKey, code, name, values: new Map(), reasonCode: "", seen: new Set() };
        if (!region.regionKey || region.codeStatus || !/^\d{5}$/.test(code) || !name) summary.reasonCode = "VISITOR_REGION_MAPPING_UNVERIFIED";
        if (byCode.has(code)) { summary.reasonCode = "VISITOR_REGION_MAPPING_AMBIGUOUS"; byCode.get(code).reasonCode = summary.reasonCode; }
        if (summaries.has(region.regionKey)) { summary.reasonCode = "VISITOR_REGION_MAPPING_AMBIGUOUS"; summaries.get(region.regionKey).reasonCode = summary.reasonCode; }
        byCode.set(code, summary);
        summaries.set(region.regionKey, summary);
      }
      const days = new Set(Array.from({ length: range.expectedDays }, (_, i) => `${range.yearMonth}${String(i + 1).padStart(2, "0")}`));
      for (let index = 0; index < rows.length; index++) {
        if (index && index % 2000 === 0) await new Promise(resolve => setImmediate(resolve));
        const row = rows[index];
        const code = String(row?.signguCode || "").trim(), name = compact(row?.signguNm);
        const summary = byCode.get(code);
        // A same-name region in another province is not a contradiction. Code
        // plus the selected code's own name must agree; name alone proves nothing.
        if (!summary) continue;
        summary.seen.add(code);
        if (!name || name !== summary.name) { summary.reasonCode = "VISITOR_RAW_REGION_MISMATCH"; continue; }
        const day = String(row.baseYmd || "").trim(), category = String(row.touDivCd || "").trim();
        const text = String(row.touNum ?? "").replace(/,/g, "").trim(), value = text === "" ? NaN : Number(text);
        if (!days.has(day) || !["1", "2", "3"].includes(category) || !Number.isFinite(value) || value < 0) {
          summary.reasonCode = "VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID"; continue;
        }
        const grain = `${day}|${category}`;
        if (summary.values.has(grain) && summary.values.get(grain) !== value) summary.reasonCode = "VISITOR_RAW_DUPLICATE_CONFLICT";
        else summary.values.set(grain, value);
      }
      const result = {};
      for (const summary of summaries.values()) {
        let total = 0;
        const categories = { "1": 0, "2": 0, "3": 0 };
        const completeDays = [...days].filter(day => ["1", "2", "3"].every(category => summary.values.has(`${day}|${category}`)));
        if (completeDays.length !== range.expectedDays && !summary.reasonCode) summary.reasonCode = "VISITOR_RAW_INCOMPLETE_DAYS";
        for (const day of completeDays) for (const category of ["1", "2", "3"]) {
          const value = summary.values.get(`${day}|${category}`); categories[category] += value; total += value;
        }
        result[summary.regionKey] = { reasonCode: summary.reasonCode, regionCode: summary.code,
          observedRegionCodes: [...summary.seen].sort(), observedDays: completeDays.length,
          averageDailyVisitors: Math.round(total / range.expectedDays), visitorDays: Math.round(total),
          categoryVisitorDays: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, Math.round(value)])) };
      }
      const after = await fs.stat(filename);
      condition(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && before.ino === after.ino && bytes.length === before.size, "VISITOR_ORIGINAL_CHANGED_DURING_READ");
      stats.verifiedMonths++;
      return { summaries: result, evidenceId, relativePath, sha256: reference.sha256,
        verifiedAt: new Date(now()).toISOString(), period: `${range.yearMonth.slice(0, 4)}-${range.yearMonth.slice(4)}` };
    });
  }

  async function restoreVisitorSnapshot({ snapshot = {}, regionMap = {}, range = {}, adapter = "" } = {}) {
    const rows = Array.isArray(snapshot.allRegions) ? snapshot.allRegions : [];
    const already = row => row?.quality?.spatialEvidence?.verified === true;
    const withFailure = reasonCode => ({ ...snapshot, allRegions: rows.map(row => ({ ...row, quality: {
      ...row.quality, storedEvidenceVerification: already(row) ? diagnostic("already_verified")
        : diagnostic(/NOT_(STORED|FOUND)$/.test(reasonCode) ? "pending" : "rejected", reasonCode)
    } })) });
    if (rows.every(already)) return withFailure("");
    try {
      condition(snapshot.status === "ok" && snapshot.adapter === adapter && snapshot.yearMonth === range.yearMonth
        && snapshot.regionMapVersion === regionMap.version && Array.isArray(regionMap.regions), "VISITOR_CACHE_IDENTITY_MISMATCH");
      const source = await originalSummary({ snapshot, regionMap, range, adapter });
      const keys = rows.map(row => row.regionKey);
      return { ...snapshot, allRegions: rows.map(row => {
        if (already(row)) return { ...row, quality: { ...row.quality, storedEvidenceVerification: diagnostic("already_verified") } };
        const summary = source.summaries[row.regionKey];
        let reasonCode = summary?.reasonCode || (summary ? "" : "VISITOR_REGION_MAPPING_UNVERIFIED");
        if (keys.filter(key => key === row.regionKey).length !== 1) reasonCode = "VISITOR_CACHE_REGION_AMBIGUOUS";
        if (!reasonCode && (row.quality?.status !== "complete" || row.signguCode !== summary.regionCode
          || row.yearMonth !== range.yearMonth || row.observedDays !== range.expectedDays || row.expectedDays !== range.expectedDays
          || row.averageDailyVisitors !== summary.averageDailyVisitors || row.visitorDays !== summary.visitorDays)) {
          reasonCode = "VISITOR_STORED_VALUES_MISMATCH";
        }
        if (!reasonCode && row.categoryVisitorDays && ["1", "2", "3"].some(key => row.categoryVisitorDays[key] !== summary.categoryVisitorDays[key])) {
          reasonCode = "VISITOR_STORED_VALUES_MISMATCH";
        }
        const verified = !reasonCode;
        const quality = { ...row.quality, storedEvidenceVerification: diagnostic(verified ? "restored" : "rejected", reasonCode) };
        if (verified) quality.spatialEvidence = { verified: true, regionKey: row.regionKey, regionCode: summary.regionCode,
          level: "sigungu", mappingStatus: "mapped", observedRegionCodes: summary.observedRegionCodes, reasonCode: "",
          storedProvenance: { version: VERSION, sourceKind: "stored_raw_response", evidenceId: source.evidenceId,
            sha256: source.sha256, verifiedAt: source.verifiedAt, period: source.period, relativePath: source.relativePath, checks: [...CHECKS] } };
        else if (reasonCode === "VISITOR_RAW_REGION_MISMATCH") quality.spatialEvidence = { verified: false,
          regionKey: row.regionKey, regionCode: "", level: "sigungu", mappingStatus: "mapped",
          observedRegionCodes: summary.observedRegionCodes, reasonCode: "REGION_MISMATCH" };
        return { ...row, quality };
      }) };
    } catch (error) { return withFailure(failureCode(error)); }
  }

  async function restoreOperationSnapshot({ snapshot = {}, sourceKey = "", adapter = "", regionMap = {},
    region = {}, operationDefs = {}, normalizeRows } = {}) {
    const operations = {};
    const yearMonth = snapshot.yearMonth;
    for (const [key, definition] of Object.entries(operationDefs)) {
      const operation = snapshot.operations?.[key];
      if (!operation) continue;
      const reference = operation.rawResponseEvidence;
      if (!reference || reference.status !== "stored") {
        operations[key] = markUnstoredOperations({ operations: { [key]: operation } }).operations[key];
        continue;
      }
      try {
        condition(operationStore && typeof operationStore.read === "function", "TOURISM_ORIGINAL_RESPONSE_NOT_FOUND");
        condition(snapshot.adapter === adapter && snapshot.regionMapVersion === regionMap.version && snapshot.region?.regionKey === region.regionKey
          && /^20\d{2}(0[1-9]|1[0-2])$/.test(yearMonth || "") && !region.codeStatus && /^\d{5}$/.test(region.ktoSggCd || ""), "TOURISM_CACHE_IDENTITY_MISMATCH");
        const identity = operationIdentity({ sourceKey, adapter, yearMonth, region, operation: definition.operation });
        const original = await operationStore.read(reference, { kind: OPERATION_KIND, identity });
        const response = original.payload?.response;
        condition(response?.schemaVersion === 1 && Array.isArray(response.queries), "TOURISM_ORIGINAL_SCHEMA_INVALID");
        const rows = verifiedOperationRows(response.queries, definition, sourceKey);
        // The existing normalizer still owns metric definitions. Strict original
        // checks additionally require the actual code and name in every row.
        for (let index = 0; index < rows.length; index++) {
          if (index && index % 2000 === 0) await new Promise(resolve => setImmediate(resolve));
          const row = rows[index];
          condition(String(row.baseYm || "") === yearMonth, "TOURISM_ORIGINAL_PERIOD_MISMATCH");
          condition(String(row.signguCd || "") === region.ktoSggCd && compact(row.signguNm) === compact(region.sigungu)
            && String(row.areaCd || "") === String(region.ktoSidoCd || "")
            && [region.sido, region.sidoFull, ...(region.sidoAliases || [])].some(name => compact(name) && compact(name) === compact(row.areaNm)), "TOURISM_ORIGINAL_REGION_MISMATCH");
          const text = String(row[definition.valueField] ?? "").replace(/,/g, "").trim();
          condition(text !== "" && Number.isFinite(Number(text)) && Number(text) >= 0, "TOURISM_ORIGINAL_VALUE_INVALID");
        }
        const normalized = normalizeRows(rows, definition, region, yearMonth);
        condition(normalized.status === "ok" && normalized.quality?.spatialEvidence?.verified === true
          && !normalized.quality?.invalidRowCount && !normalized.quality?.mismatchedRowCount && !normalized.quality?.conflictCount
          && !normalized.quality?.unexpectedCodes?.length, "TOURISM_ORIGINAL_METRICS_INVALID");
        condition(operation.status === "ok" && operation.overallCode === normalized.overallCode
          && operation.overallValue === normalized.overallValue, "TOURISM_STORED_VALUES_MISMATCH");
        const metrics = new Map();
        for (const metric of operation.metrics || []) {
          condition(!metrics.has(metric.code), "TOURISM_STORED_VALUES_MISMATCH"); metrics.set(metric.code, metric);
        }
        condition(metrics.size === normalized.metrics.length && normalized.metrics.every(metric => metrics.has(metric.code)
          && metrics.get(metric.code).value === metric.value && metrics.get(metric.code).sourceName === metric.sourceName), "TOURISM_STORED_VALUES_MISMATCH");
        const checks = ["safe_original_path", "original_sha256", "request_identity", "complete_response_pages",
          "raw_region_code_and_name", "raw_period", "metric_codes_and_values", "stored_metric_values"];
        const spatialEvidence = { ...normalized.quality.spatialEvidence, storedProvenance: {
          version: OPERATION_VERSION, sourceKind: "stored_raw_response", evidenceId: reference.evidenceId, sha256: reference.sha256,
          period: `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}`, verifiedAt: original.verifiedAt,
          checks
        } };
        operations[key] = { ...operation, quality: { ...operation.quality, spatialEvidence,
          storedEvidenceVerification: { status: "restored", reasonCode: "", version: OPERATION_VERSION } } };
      } catch (error) {
        const reasonCode = operationFailureCode(error);
        const pending = /NOT_(STORED|FOUND)|MISSING/.test(reasonCode);
        const spatialEvidence = { ...(operation.quality?.spatialEvidence || {}), verified: false,
          regionKey: region.regionKey, regionCode: "", level: "sigungu", mappingStatus: "mapped",
          reasonCode: reasonCode === "TOURISM_ORIGINAL_REGION_MISMATCH" ? "REGION_MISMATCH" : "INVALID_RESPONSE" };
        delete spatialEvidence.storedProvenance;
        operations[key] = { ...operation, quality: { ...operation.quality, spatialEvidence,
          storedEvidenceVerification: { status: pending ? "pending" : "rejected", reasonCode, version: OPERATION_VERSION } } };
      }
    }
    return { ...snapshot, operations: { ...snapshot.operations, ...operations } };
  }

  return { restoreVisitorSnapshot, restoreOperationSnapshot, stats: () => ({ ...stats, memoEntries: memo.size }) };
}

function operationFailureCode(error) {
  if (error?.code === "ENOENT") return "TOURISM_ORIGINAL_RESPONSE_NOT_FOUND";
  const value = error?.reasonCode || error?.code;
  return /^[A-Z0-9_]{1,100}$/.test(value || "") ? value : "TOURISM_ORIGINAL_RESPONSE_UNREADABLE";
}
function operationIdentity({ sourceKey, adapter, yearMonth, region, operation }) {
  return { sourceKey, adapter, yearMonth, regionKey: region.regionKey, regionCode: String(region.ktoSggCd || ""), operation };
}
function verifiedOperationRows(queries, definition, sourceKey) {
  const expected = sourceKey === "demandStrength" ? [definition.overallCode] : Object.keys(definition.expectedMetrics || {});
  condition(queries.length === expected.length, "TOURISM_ORIGINAL_QUERY_INCOMPLETE");
  const seenQueries = new Set(), rows = [];
  for (const query of queries) {
    condition(expected.includes(query.metricCode) && !seenQueries.has(query.metricCode), "TOURISM_ORIGINAL_QUERY_MISMATCH");
    seenQueries.add(query.metricCode);
    condition(Array.isArray(query.pages) && query.pages.length > 0 && query.pages.length <= 50, "TOURISM_ORIGINAL_PAGE_INCOMPLETE");
    let total = null, received = 0;
    for (let index = 0; index < query.pages.length; index++) {
      const page = query.pages[index];
      condition(Number.isInteger(page.httpStatus) && page.httpStatus >= 200 && page.httpStatus < 300
        && ["0000", "00"].includes(page.apiCode), "TOURISM_ORIGINAL_RESPONSE_FAILED");
      condition(page.requestedPageNo === index + 1 && page.pageNo === index + 1
        && Number.isInteger(page.requestedPageSize) && page.requestedPageSize > 0
        && Number.isInteger(page.numOfRows) && page.numOfRows > 0
        && Number.isInteger(page.totalCount) && page.totalCount >= 0 && Array.isArray(page.rows)
        && page.receivedRowCount === page.rows.length && page.rows.length <= page.numOfRows,
      "TOURISM_ORIGINAL_PAGINATION_INVALID");
      if (total === null) total = page.totalCount;
      condition(total === page.totalCount && received < total && page.rows.length > 0, "TOURISM_ORIGINAL_PAGE_INCOMPLETE");
      received += page.rows.length;
      condition(received <= total && received <= MAX_ROWS, "TOURISM_ORIGINAL_ROW_COUNT_INVALID");
      if (index < query.pages.length - 1) condition(page.rows.length === page.numOfRows, "TOURISM_ORIGINAL_PAGE_INCOMPLETE");
      for (const row of page.rows) {
        condition(sourceKey === "demandStrength" || String(row?.[definition.codeField] || "") === query.metricCode, "TOURISM_ORIGINAL_METRIC_CODE_MISMATCH");
        rows.push(row);
      }
    }
    condition(total > 0 && received === total, "TOURISM_ORIGINAL_PAGE_INCOMPLETE");
  }
  condition(rows.length > 0 && rows.length <= MAX_ROWS, "TOURISM_ORIGINAL_ROW_COUNT_INVALID");
  return rows;
}

function markUnstoredOperations(snapshot = {}) {
  return { ...snapshot, operations: Object.fromEntries(Object.entries(snapshot.operations || {}).map(([key, operation]) => {
    const storageFailed = operation.rawResponseEvidence?.status === "not_stored" || operation.quality?.responseEvidenceStorage?.status === "failed";
    const storedEvidenceVerification = storageFailed ? { status: "pending", reasonCode: "EVIDENCE_WRITE_ERROR", version: OPERATION_VERSION }
      : operation.quality?.spatialEvidence?.verified === true ? diagnostic("already_verified")
        : diagnostic("pending", "TOURISM_ORIGINAL_RESPONSE_NOT_STORED");
    return [key, { ...operation, quality: { ...operation.quality, storedEvidenceVerification } }];
  })) };
}

module.exports = { VERSION, OPERATION_VERSION, OPERATION_KIND, MAX_BYTES, MAX_ROWS, createStoredTourismEvidenceRestorer, markUnstoredOperations, operationIdentity };
