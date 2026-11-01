"use strict";

const fs = require("node:fs/promises"), constants = require("node:fs").constants;
const path = require("node:path"), crypto = require("node:crypto");
const M = require("./search_demand_model.cjs");
const MAX = Object.freeze({ snapshot: 32 * 1024 * 1024, catalog: 16 * 1024 * 1024, day: 16 * 1024 * 1024, forecast: 64 * 1024, snapshots: 20000, forecasts: 20000 });
const FORECAST_ID = /^sf_[a-f0-9]{64}$/;
const FORECAST_FIELDS = ["schemaVersion", "keyword", "keywordId", "modelVersion", "targetMonth", "calculatedAt", "sourceSnapshotIds", "trendWindowId", "status", "value", "inputVolume", "factor", "changeRate", "basePeriod", "seasonalPeriod", "method", "reasonCode", "metricDefinition", "searchObservedAt", "trendObservedAt"];
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const equal = (a, b) => M.stableStringify(a) === M.stableStringify(b);
const clone = value => JSON.parse(JSON.stringify(value));
const need = (condition, code = "SEARCH_DEMAND_STORE_INVALID") => { if (!condition) throw M.problem(code, 503); };
const sameStat = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]);
const canonicalPath = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function createSearchDemandStore({ rootDir, clock = () => new Date() } = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir) || typeof clock !== "function") throw M.problem();
  const root = path.resolve(rootDir); let writes = Promise.resolve();
  function now() { const value = new Date(clock()); if (!Number.isFinite(value.getTime())) throw M.problem("SEARCH_DEMAND_CLOCK_INVALID", 503); return value.toISOString(); }
  function location(relative) {
    need(typeof relative === "string" && relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(part => part === ".." || part === "."), "SEARCH_DEMAND_PATH_INVALID");
    const file = path.resolve(root, relative);
    need(file.startsWith(root + path.sep), "SEARCH_DEMAND_PATH_INVALID"); return file;
  }
  async function parents(file, { missing = false } = {}) {
    let current = path.parse(file).root;
    for (const part of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); let stat;
      try { stat = await fs.lstat(current); } catch (error) { if (missing && error.code === "ENOENT") return false; throw error; }
      need(stat.isDirectory() && !stat.isSymbolicLink() && canonicalPath(await fs.realpath(current)) === canonicalPath(current), "SEARCH_DEMAND_UNSAFE_PATH");
    } return true;
  }
  async function ensureDirectory(directory) {
    await parents(path.join(directory, "__check"), { missing: true });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await parents(path.join(directory, "__check"));
  }
  async function read(relative, maximum, { optional = false } = {}) {
    const file = location(relative); let handle;
    try {
      if (!await parents(file, { missing: optional })) return null;
      const before = await fs.lstat(file);
      need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum && before.size > 0
        && canonicalPath(await fs.realpath(file)) === canonicalPath(file), "SEARCH_DEMAND_UNSAFE_OR_OVERSIZE_FILE");
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      need(sameStat(before, await handle.stat()), "SEARCH_DEMAND_EVIDENCE_CHANGED");
      const bytes = Buffer.alloc(before.size + 1); let received = 0;
      while (received < bytes.length) { const result = await handle.read(bytes, received, bytes.length - received, received); if (!result.bytesRead) break; received += result.bytesRead; }
      need(received === before.size && sameStat(before, await handle.stat()) && sameStat(before, await fs.lstat(file)), "SEARCH_DEMAND_EVIDENCE_CHANGED");
      await parents(file);
      const raw = bytes.subarray(0, received); let data;
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw M.problem("SEARCH_DEMAND_JSON_INVALID", 503); }
      return { data, bytes: raw.length, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
    } catch (error) { if (optional && error.code === "ENOENT") return null; if (/^SEARCH_DEMAND_/.test(error.code || "")) throw error; throw M.problem("SEARCH_DEMAND_READ_FAILED", 503); }
    finally { await handle?.close(); }
  }
  async function immutable(relative, data, maximum) {
    const file = location(relative), raw = Buffer.from(M.stableStringify(data) + "\n");
    need(raw.length <= maximum, "SEARCH_DEMAND_WRITE_BOUNDS"); await ensureDirectory(path.dirname(file));
    let handle;
    try {
      handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
    } catch (error) {
      if (error.code !== "EEXIST") { if (/^SEARCH_DEMAND_/.test(error.code || "")) throw error; throw M.problem("SEARCH_DEMAND_WRITE_FAILED", 503); }
      const existing = await read(relative, maximum);
      need(equal(existing.data, data), "SEARCH_DEMAND_IMMUTABLE_CONFLICT");
      return { bytes: existing.bytes, sha256: existing.sha256, created: false };
    } finally { await handle?.close(); }
    const result = await read(relative, maximum); need(equal(result.data, data), "SEARCH_DEMAND_WRITE_READBACK_FAILED");
    return { bytes: result.bytes, sha256: result.sha256, created: true };
  }
  async function publish(relative, data, maximum) {
    const file = location(relative), raw = Buffer.from(M.stableStringify(data) + "\n");
    need(raw.length <= maximum, "SEARCH_DEMAND_WRITE_BOUNDS"); await ensureDirectory(path.dirname(file));
    const tempRelative = relative + "." + crypto.randomUUID() + ".tmp", temp = location(tempRelative); let handle;
    try {
      handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
      try { const stat = await fs.lstat(file); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "SEARCH_DEMAND_UNSAFE_PATH"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await parents(file); await fs.rename(temp, file);
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
  }
  async function fileLock(operation) {
    await ensureDirectory(root); const lock = location("writer.lock"); let handle;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw M.problem("SEARCH_DEMAND_WRITE_FAILED", 503); if (attempt === 49) throw M.problem("SEARCH_DEMAND_STORE_BUSY", 409); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const identity = await handle.stat();
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, startedAt: now() }) + "\n"); await handle.sync(); return await operation(); }
    finally {
      try { const current = await fs.lstat(lock); need(current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino, "SEARCH_DEMAND_LOCK_CHANGED"); await fs.unlink(lock); }
      finally { await handle.close(); }
    }
  }
  function write(operation) { const result = writes.then(() => fileLock(operation)); writes = result.catch(() => {}); return result; }
  const emptyCatalog = () => ({ schemaVersion: 1, revision: 0, updatedAt: "", snapshots: [], days: {}, forecasts: [] });
  function countsValid(value, provider) {
    const required = ["returnedRows", "validRows", "invalidRows", "duplicateRows", "conflictingKeys", "uniqueRows"];
    const allowed = [...required, "reconciled", ...(provider === "searchad" ? ["partialKeys"] : [])];
    return object(value) && Object.keys(value).every(key => allowed.includes(key))
      && required.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= M.MAX_ROWS)
      && value.reconciled === true && value.returnedRows === value.validRows + value.invalidRows && value.validRows === value.uniqueRows + value.duplicateRows
      && value.conflictingKeys <= value.uniqueRows
      && (provider !== "searchad" || Number.isSafeInteger(value.partialKeys) && value.partialKeys >= 0 && value.partialKeys <= value.uniqueRows);
  }
  function metadataValid(value) {
    try {
      const allowed = ["schemaVersion", "provider", "snapshotId", "keywordId", "keyword", "normalized", "scopeId", "day", "observedAt", "status", "counts", "connectionProvider", "startDate", "endDate", "windowId"];
      const identity = M.normalizeKeyword(value?.keyword);
      return object(value) && Object.keys(value).every(key => allowed.includes(key)) && value.schemaVersion === 1 && M.SNAPSHOT_ID.test(value.snapshotId || "") && ["searchad", "datalab"].includes(value.provider)
        && M.KEYWORD_ID.test(value.keywordId || "") && M.dateValid(value.day) && M.isoValid(value.observedAt) && value.day === M.dayFromIso(value.observedAt)
        && ["ready", "partial", "missing"].includes(value.status) && countsValid(value.counts, value.provider)
        && typeof value.scopeId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value.scopeId)
        && identity.keywordId === value.keywordId && identity.normalized === value.normalized
        && (value.connectionProvider === undefined || ["developers", "ncp_apihub"].includes(value.connectionProvider))
        && (value.provider !== "datalab" || M.dateValid(value.startDate) && M.dateValid(value.endDate) && value.startDate <= value.endDate && M.WINDOW_ID.test(value.windowId || ""));
    } catch { return false; }
  }
  async function catalog() {
    const record = await read("index/catalog.json", MAX.catalog, { optional: true }); if (!record) return emptyCatalog();
    const value = record.data;
    need(object(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && M.isoValid(value.updatedAt)
      && Array.isArray(value.snapshots) && value.snapshots.length <= MAX.snapshots && value.snapshots.every(metadataValid)
      && new Set(value.snapshots.map(row => row.snapshotId)).size === value.snapshots.length && object(value.days) && Array.isArray(value.forecasts) && value.forecasts.length <= MAX.forecasts, "SEARCH_DEMAND_CATALOG_INVALID");
    for (const [day, pointer] of Object.entries(value.days)) need(M.dateValid(day) && object(pointer) && /^index\/days\/20\d{2}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/.test(pointer.file || "")
      && /^[a-f0-9]{64}$/.test(pointer.sha256 || "") && Number.isSafeInteger(pointer.bytes) && pointer.bytes > 0 && pointer.bytes <= MAX.day, "SEARCH_DEMAND_CATALOG_INVALID");
    for (const entry of value.forecasts) need(object(entry) && FORECAST_ID.test(entry.forecastId || "") && M.KEYWORD_ID.test(entry.keywordId || "") && M.monthValid(entry.targetMonth) && M.isoValid(entry.calculatedAt), "SEARCH_DEMAND_CATALOG_INVALID");
    return value;
  }
  async function snapshot(snapshotId, metadata) {
    need(M.SNAPSHOT_ID.test(snapshotId || ""), "SEARCH_DEMAND_SNAPSHOT_ID_INVALID");
    const record = await read("snapshots/" + snapshotId + ".json", MAX.snapshot), value = M.validateSnapshot(record.data);
    need(value.snapshotId === snapshotId && (!metadata || equal(M.safeMetadata(value), M.safeMetadata(metadata)) && value.scopeId === metadata.scopeId), "SEARCH_DEMAND_SNAPSHOT_BINDING_INVALID");
    return value;
  }
  async function dayIndex(day, cat) {
    const pointer = cat.days[day]; if (!pointer) return { schemaVersion: 1, day, snapshots: {}, keywords: {} };
    const record = await read(pointer.file, MAX.day), value = record.data;
    need(record.bytes === pointer.bytes && record.sha256 === pointer.sha256 && object(value) && value.schemaVersion === 1 && value.day === day && object(value.snapshots) && object(value.keywords), "SEARCH_DEMAND_DAY_INDEX_INVALID");
    const known = new Map(cat.snapshots.map(row => [row.snapshotId, row]));
    for (const [id, metadata] of Object.entries(value.snapshots)) need(known.has(id) && equal(metadata, known.get(id)) && metadata.day === day, "SEARCH_DEMAND_DAY_INDEX_INVALID");
    for (const [key, rows] of Object.entries(value.keywords)) need(M.KEYWORD_ID.test(key) && Array.isArray(rows) && rows.every(row => object(row) && M.SNAPSHOT_ID.test(row.snapshotId || "")
      && value.snapshots[row.snapshotId]?.provider === "searchad" && Number.isSafeInteger(row.rowIndex) && row.rowIndex >= 0 && row.rowIndex < M.MAX_ROWS), "SEARCH_DEMAND_DAY_INDEX_INVALID");
    return value;
  }
  async function saveSnapshot(value) {
    M.validateSnapshot(value); const safeValue = clone(value);
    return write(async () => {
      const cat = await catalog(), existing = cat.snapshots.find(row => row.snapshotId === safeValue.snapshotId);
      if (existing) { need(equal(await snapshot(existing.snapshotId, existing), safeValue), "SEARCH_DEMAND_IMMUTABLE_CONFLICT"); return { snapshotId: existing.snapshotId, created: false, reused: true, provider: existing.provider, keywordId: existing.keywordId, day: existing.day }; }
      need(cat.snapshots.length < MAX.snapshots, "SEARCH_DEMAND_CATALOG_BOUNDS");
      await immutable("snapshots/" + safeValue.snapshotId + ".json", safeValue, MAX.snapshot);
      const metadata = { ...M.safeMetadata(safeValue), normalized: safeValue.normalized, scopeId: safeValue.scopeId };
      const index = await dayIndex(safeValue.day, cat); index.snapshots[safeValue.snapshotId] = metadata;
      if (safeValue.provider === "searchad") safeValue.observations.forEach((row, rowIndex) => {
        const list = index.keywords[row.keywordId] || []; list.push({ snapshotId: safeValue.snapshotId, rowIndex }); index.keywords[row.keywordId] = list;
      });
      const indexRelative = "index/days/" + safeValue.day + "/" + M.hash(index) + ".json";
      const savedIndex = await immutable(indexRelative, index, MAX.day);
      cat.snapshots.push(metadata); cat.days[safeValue.day] = { file: indexRelative, bytes: savedIndex.bytes, sha256: savedIndex.sha256 };
      cat.revision += 1; cat.updatedAt = now(); await publish("index/catalog.json", cat, MAX.catalog);
      return { snapshotId: safeValue.snapshotId, created: true, reused: false, provider: safeValue.provider, keywordId: safeValue.keywordId, day: safeValue.day };
    });
  }
  function validateQuery(input = {}) {
    if (!object(input) || !["searchad", "datalab"].includes(input.provider) || input.day && !M.dateValid(input.day) || input.asOfDay && !M.dateValid(input.asOfDay) || input.day && input.asOfDay) throw M.problem();
    return { provider: input.provider, day: input.day, asOfDay: input.asOfDay, ...M.normalizeKeyword(input.keyword) };
  }
  const latestFirst = (a, b) => b.observedAt.localeCompare(a.observedAt) || b.snapshotId.localeCompare(a.snapshotId);
  async function findLatest(input, cat, { readyOnly = false } = {}) {
    const query = validateQuery(input), candidates = cat.snapshots.filter(row => row.provider === query.provider && row.keywordId === query.keywordId
      && (!query.day || row.day === query.day) && (!query.asOfDay || row.day <= query.asOfDay) && (!readyOnly || row.status === "ready"));
    candidates.sort(latestFirst); return candidates.length ? snapshot(candidates[0].snapshotId, candidates[0]) : null;
  }
  async function readLatest(input) { return findLatest(input, await catalog()); }
  async function readSnapshot(input = {}) {
    if (!object(input) || Object.keys(input).some(key => key !== "snapshotId") || !M.SNAPSHOT_ID.test(input.snapshotId || "")) throw M.problem();
    const cat = await catalog(), metadata = cat.snapshots.find(row => row.snapshotId === input.snapshotId);
    return metadata ? snapshot(metadata.snapshotId, metadata) : null;
  }
  async function listSnapshots(input = {}) {
    if (!object(input) || input.provider !== undefined && !["searchad", "datalab"].includes(input.provider)) throw M.problem();
    const id = input.keyword ? M.normalizeKeyword(input.keyword).keywordId : null, limit = Number(input.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw M.problem();
    const cat = await catalog(), rows = cat.snapshots.filter(row => (!id || row.keywordId === id) && (!input.provider || row.provider === input.provider)).sort(latestFirst);
    return { rows: rows.slice(0, limit).map(M.safeMetadata), total: rows.length, limit, truncated: rows.length > limit };
  }
  async function dailyFromCatalog({ keyword, from, to, scopeId }, cat) {
    const identity = M.normalizeKeyword(keyword), days = M.daysBetween(from, to), rows = [];
    for (const day of days) {
      const index = await dayIndex(day, cat), candidates = (index.keywords[identity.keywordId] || []).map(ref => ({ ...ref, metadata: index.snapshots[ref.snapshotId] }))
        .filter(ref => !scopeId || ref.metadata.scopeId === scopeId).sort((a, b) => latestFirst(a.metadata, b.metadata));
      if (!candidates.length) continue;
      let selected = null, first = null;
      for (const ref of candidates) {
        const value = await snapshot(ref.snapshotId, ref.metadata), row = value.observations[ref.rowIndex];
        need(row?.keywordId === identity.keywordId, "SEARCH_DEMAND_DAY_INDEX_BINDING_INVALID");
        const item = { day, observedAt: value.observedAt, snapshotId: value.snapshotId, ...M.publicRow(row), sourceAnchorKeyword: value.keyword };
        if (!first) first = item;
        if (row.status !== "partial" && !row.conflicting) { selected = item; break; }
      }
      rows.push(selected || first);
    }
    return { keyword: identity.keyword, keywordId: identity.keywordId, from, to, rows, observedDays: rows.length,
      missingDaysCount: days.length - rows.length, duplicateAdoption: false };
  }
  async function listDaily(input = {}) {
    if (!object(input)) throw M.problem(); const cat = await catalog();
    return dailyFromCatalog(input, cat);
  }
  async function getAnalysis(input = {}) {
    const selection = M.normalizeSelection(input, new Date(now())), cat = await catalog();
    const newest = await findLatest({ provider: "searchad", keyword: selection.keyword, asOfDay: selection.day }, cat);
    const fallback = newest?.anchor && newest.anchor.status !== "partial" ? newest : await findLatest({ provider: "searchad", keyword: selection.keyword, asOfDay: selection.day }, cat, { readyOnly: true });
    const searchSnapshot = fallback || newest;
    const trendSnapshot = await findLatest({ provider: "datalab", keyword: selection.keyword, asOfDay: selection.day }, cat);
    const range = M.monthRange(selection.month), lastDay = range.to < selection.day ? range.to : selection.day;
    const daily = range.from > lastDay ? { rows: [] } : await dailyFromCatalog({ keyword: selection.relatedKeyword || selection.keyword, from: range.from, to: lastDay, scopeId: searchSnapshot?.scopeId }, cat);
    const history = cat.snapshots.filter(row => row.keywordId === selection.keywordId && row.day <= selection.day).sort(latestFirst);
    const model = M.buildSearchDemandAnalysis({ selection, searchSnapshot, trendSnapshot, dailyRows: daily.rows, history: history.slice(0, 100), historyTotal: history.length, now: new Date(now()) });
    if (newest && searchSnapshot && newest.snapshotId !== searchSnapshot.snapshotId) { model.searchVolume.status = "stale"; model.searchVolume.stale = true; model.searchVolume.latestAttemptStatus = newest.status; }
    return model;
  }
  async function listKeywords() {
    const cat = await catalog(), found = new Map();
    for (const row of cat.snapshots) {
      const previous = found.get(row.keywordId);
      if (!previous) found.set(row.keywordId, { keywordId: row.keywordId, keyword: row.keyword, firstObservedAt: row.observedAt, lastObservedAt: row.observedAt });
      else { if (row.observedAt < previous.firstObservedAt) previous.firstObservedAt = row.observedAt; if (row.observedAt > previous.lastObservedAt) previous.lastObservedAt = row.observedAt; }
    }
    return [...found.values()].sort((a, b) => a.keyword.localeCompare(b.keyword, "ko"));
  }
  function validateForecast(record) {
    need(object(record) && Object.keys(record).every(key => FORECAST_FIELDS.includes(key)) && FORECAST_FIELDS.every(key => Object.hasOwn(record, key)), "SEARCH_DEMAND_FORECAST_INVALID");
    need(record.schemaVersion === 1 && record.status === "verified" && record.modelVersion === "legacy-demand-ratio-v1" && record.reasonCode === "FORECAST_INPUTS_VERIFIED"
      && record.metricDefinition === "estimated_monthly_search_scale" && M.normalizeKeyword(record.keyword).keywordId === record.keywordId && M.KEYWORD_ID.test(record.keywordId)
      && M.monthValid(record.targetMonth) && M.monthValid(record.basePeriod) && (record.seasonalPeriod === null || M.monthValid(record.seasonalPeriod))
      && ["seasonal_ratio", "recent_three_month", "twelve_month_trend"].includes(record.method) && M.isoValid(record.calculatedAt) && M.isoValid(record.searchObservedAt) && M.isoValid(record.trendObservedAt)
      && Array.isArray(record.sourceSnapshotIds) && record.sourceSnapshotIds.length === 2 && new Set(record.sourceSnapshotIds).size === 2 && record.sourceSnapshotIds.every(value => M.SNAPSHOT_ID.test(value))
      && M.WINDOW_ID.test(record.trendWindowId || "") && ["value", "inputVolume", "factor"].every(key => typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0)
      && typeof record.changeRate === "number" && Number.isFinite(record.changeRate), "SEARCH_DEMAND_FORECAST_INVALID");
    return record;
  }
  async function saveForecast(record) {
    validateForecast(record); const value = clone(record);
    return write(async () => {
      const cat = await catalog(), metadata = value.sourceSnapshotIds.map(id => cat.snapshots.find(row => row.snapshotId === id));
      need(metadata.every(Boolean) && metadata.every(row => row.keywordId === value.keywordId) && new Set(metadata.map(row => row.provider)).size === 2, "SEARCH_DEMAND_FORECAST_SOURCE_MISMATCH");
      const inputs = await Promise.all(metadata.map(row => snapshot(row.snapshotId, row))), search = inputs.find(row => row.provider === "searchad"), trend = inputs.find(row => row.provider === "datalab");
      need(search.status === "ready" && search.anchor?.total.state === "number" && search.anchor.total.value === value.inputVolume && trend.status === "ready"
        && trend.windowId === value.trendWindowId && search.observedAt === value.searchObservedAt && trend.observedAt === value.trendObservedAt, "SEARCH_DEMAND_FORECAST_SOURCE_MISMATCH");
      const contentSha256 = M.hash(value), forecastId = "sf_" + contentSha256, output = { ...value, forecastId, contentSha256 };
      await immutable("forecasts/" + forecastId + ".json", output, MAX.forecast);
      if (!cat.forecasts.some(row => row.forecastId === forecastId)) {
        need(cat.forecasts.length < MAX.forecasts, "SEARCH_DEMAND_CATALOG_BOUNDS");
        cat.forecasts.push({ forecastId, keywordId: value.keywordId, keyword: value.keyword, targetMonth: value.targetMonth, calculatedAt: value.calculatedAt });
        cat.revision += 1; cat.updatedAt = now(); await publish("index/catalog.json", cat, MAX.catalog);
      }
      return output;
    });
  }
  async function listForecasts(input = {}) {
    if (!object(input)) throw M.problem(); const identity = M.normalizeKeyword(input.keyword), limit = Number(input.limit ?? 100);
    if (input.month !== undefined && !M.monthValid(input.month) || input.day !== undefined && !M.dateValid(input.day) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw M.problem();
    const cat = await catalog(), matches = cat.forecasts.filter(row => row.keywordId === identity.keywordId && (!input.month || row.targetMonth === input.month)
      && (!input.day || M.dayFromIso(row.calculatedAt) <= input.day)).sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt) || b.forecastId.localeCompare(a.forecastId));
    const rows = [];
    for (const metadata of matches.slice(0, limit)) {
      const stored = await read("forecasts/" + metadata.forecastId + ".json", MAX.forecast), value = stored.data;
      const { forecastId, contentSha256, ...record } = value; validateForecast(record);
      need(forecastId === metadata.forecastId && M.hash(record) === contentSha256 && forecastId === "sf_" + contentSha256 && record.keywordId === metadata.keywordId && record.targetMonth === metadata.targetMonth && record.calculatedAt === metadata.calculatedAt, "SEARCH_DEMAND_FORECAST_HASH_MISMATCH");
      rows.push(value);
    }
    return { rows, total: matches.length, limit, truncated: matches.length > limit };
  }
  return { saveSnapshot, readSnapshot, readLatest, listDaily, listSnapshots, getAnalysis, listKeywords, saveForecast, listForecasts };
}
module.exports = { createSearchDemandStore, MAX };
