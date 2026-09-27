"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ENDPOINT = "https://openapi.naver.com/v1/datalab/search";
const VERSION = "region_glamping_exact_v1";
const TTL = 24 * 3600000;
const MAX_BODY = 512 * 1024;
const ERRORS = new Set(["INVALID_REQUEST", "INVALID_REGION", "INVALID_MONTH", "MISSING_KEY", "CONFIG_READ_ERROR", "AUTH_ERROR", "QUOTA_EXCEEDED",
  "TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "PERIOD_MISMATCH", "KEYWORD_MISMATCH", "PROVIDER_FAILED",
  "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "MISSING_VALUES", "NO_DATA", "PUBLICATION_PENDING"]);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function problem(code, statusCode = 503) { return Object.assign(new Error("검색 관심도 자료의 연결 또는 조회 조건을 확인해 주세요."), { code, statusCode }); }
function safeCode(error, fallback = "NETWORK_ERROR") { return ERRORS.has(error?.code) ? error.code : fallback; }
function stamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : ""; }
function shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}
function periodList(startDate, month) {
  const values = [];
  for (let current = startDate.slice(0, 7); current <= month; current = shiftMonth(current, 1)) values.push(`${current}-01`);
  return values;
}
function observedCount(result) { return (result?.series || []).filter((point) => point.status === "observed").length; }
function completePoints(result) { return Boolean(result?.series?.length) && result.series.every((point) => point.status === "observed"); }

function createRegionalSearchTrendService({ dataDir, readTrafficKeys, resolveRegion, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 15000 }) {
  if (!dataDir || typeof readTrafficKeys !== "function" || typeof resolveRegion !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw problem("INVALID_REQUEST", 400);
  const cacheDir = path.join(dataDir, "cache"), statusFile = path.join(dataDir, "status.json");
  const flights = new Map();
  let statusLock = Promise.resolve();
  const instant = () => new Date(now());
  const iso = () => instant().toISOString();
  const kstToday = () => new Date(instant().getTime() + 9 * 3600000).toISOString().slice(0, 10);
  async function keys() {
    try {
      const source = await readTrafficKeys();
      const naverClientId = typeof source?.naverClientId === "string" ? source.naverClientId.trim() : "";
      const naverClientSecret = typeof source?.naverClientSecret === "string" ? source.naverClientSecret.trim() : "";
      return { configured: Boolean(naverClientId && naverClientSecret), naverClientId, naverClientSecret };
    } catch { throw problem("CONFIG_READ_ERROR"); }
  }
  async function identity(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["regionKey", "month"].includes(key))) throw problem("INVALID_REQUEST", 400);
    const { regionKey, month } = input;
    if (typeof regionKey !== "string" || !/^[A-Za-z0-9_:-]{1,120}$/.test(regionKey)) throw problem("INVALID_REGION", 400);
    const today = kstToday();
    if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month < "2016-01" || month > today.slice(0, 7)) throw problem("INVALID_MONTH", 400);
    const region = await resolveRegion(regionKey);
    if (!region || region.regionKey !== regionKey || region.level !== "local" || region.active !== true || region.selectable !== true) throw problem("INVALID_REGION", 400);
    const raw = [region.name, region.shortName].find((value) => typeof value === "string" && value.trim()) || regionKey.split(/[_:]/).at(-1);
    const qualifiedName = /구$/.test(raw.trim()) && typeof region.fullName === "string" && region.fullName.trim() ? region.fullName : raw;
    const token = qualifiedName.trim().replace(/\s+/g, "").replace(/[시군]$/, "");
    const keyword = region.searchTrendKeyword === undefined ? `${token}글램핑` : region.searchTrendKeyword;
    if (typeof keyword !== "string" || !/^[가-힣A-Za-z0-9-]{1,60}글램핑$/.test(keyword)) throw problem("INVALID_REGION", 400);
    const firstMonth = shiftMonth(month, -11);
    const startDate = `${firstMonth < "2016-01" ? "2016-01" : firstMonth}-01`;
    const partialMonth = month === today.slice(0, 7);
    const endDate = partialMonth
      ? new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
      : new Date(Date.parse(`${shiftMonth(month, 1)}-01T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const value = { version: VERSION, regionKey, month, keyword, startDate, endDate, timeUnit: "month", partialMonth };
    return { value, hash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"), publicationPending: partialMonth && today.endsWith("-01") };
  }
  function base(info, configured) {
    const value = info.value;
    return { ...value, source: "naver_datalab_search", metric: "relative_search_interest", label: "검색 관심도 (상대지수)",
      status: info.publicationPending ? "publication_pending" : "missing", configured, networkAttempted: false, cacheReused: false,
      errorCode: info.publicationPending ? "PUBLICATION_PENDING" : "", retrievedAt: "",
      series: periodList(value.startDate, value.month).map((period) => ({ period, ratio: null, value: null, status: "missing" })),
      note: "조회한 키워드와 기간 안에서 최대 100인 상대지수입니다. 절대 검색량이나 다른 조회 조건의 지수와 합산하지 않습니다." };
  }
  function validateSnapshot(snapshot, info) {
    const expected = base(info, true);
    if (!snapshot || ["regionKey", "month", "keyword", "startDate", "endDate", "timeUnit", "version"].some((key) => snapshot[key] !== expected[key])
      || snapshot.partialMonth !== expected.partialMonth || !stamp(snapshot.retrievedAt) || !Array.isArray(snapshot.series)
      || snapshot.series.length !== expected.series.length || !["ready", "partial"].includes(snapshot.status)) throw problem("CACHE_READ_ERROR");
    for (let index = 0; index < expected.series.length; index++) {
      const point = snapshot.series[index];
      if (!point || point.period !== expected.series[index].period || !["observed", "missing"].includes(point.status)
        || (point.status === "observed" ? typeof point.ratio !== "number" || !Number.isFinite(point.ratio) || point.ratio < 0 || point.ratio > 100 || point.value !== point.ratio
          : point.ratio !== null || point.value !== null)) throw problem("CACHE_READ_ERROR");
    }
    if (!observedCount(snapshot) || snapshot.status === "ready" && (!completePoints(snapshot) || snapshot.partialMonth)) throw problem("CACHE_READ_ERROR");
    // Return only known fields, even if an older cache contains extra metadata.
    return { ...expected, status: snapshot.status, retrievedAt: snapshot.retrievedAt, series: clone(snapshot.series),
      errorCode: snapshot.status === "partial" ? "MISSING_VALUES" : "" };
  }
  async function readCache(info) {
    let stored;
    try { stored = JSON.parse(await fs.readFile(path.join(cacheDir, `${info.hash}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { snapshot: null, lastAttempt: null }; throw problem("CACHE_READ_ERROR"); }
    if (stored.version !== 1 || stored.identity !== info.hash || !stored.lastAttempt || !stamp(stored.lastAttempt.at)
      || !["ready", "partial", "missing", "failed", "publication_pending"].includes(stored.lastAttempt.status)
      || stored.lastAttempt.errorCode && !ERRORS.has(stored.lastAttempt.errorCode)) throw problem("CACHE_READ_ERROR");
    return { snapshot: stored.snapshot ? validateSnapshot(stored.snapshot, info) : null,
      lastAttempt: { at: stored.lastAttempt.at, status: stored.lastAttempt.status, errorCode: stored.lastAttempt.errorCode || "" } };
  }
  async function atomic(file, data) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, file);
    } catch { throw problem("CACHE_WRITE_ERROR"); }
  }
  async function readStatus() {
    try {
      const stored = JSON.parse(await fs.readFile(statusFile, "utf8"));
      if (stored.version !== 1 || stored.lastCheckedAt && !stamp(stored.lastCheckedAt) || stored.lastSuccessAt && !stamp(stored.lastSuccessAt)
        || stored.errorCode && !ERRORS.has(stored.errorCode)) throw problem("CACHE_READ_ERROR");
      return { lastCheckedAt: stored.lastCheckedAt || "", lastSuccessAt: stored.lastSuccessAt || "", errorCode: stored.errorCode || "" };
    } catch (error) {
      if (error.code === "ENOENT") return { lastCheckedAt: "", lastSuccessAt: "", errorCode: "" };
      throw problem("CACHE_READ_ERROR");
    }
  }
  async function rememberStatus(result) {
    const task = statusLock.then(async () => {
      const previous = await readStatus();
      const successful = completePoints(result) && !["failed", "missing", "publication_pending"].includes(result.status) && !result.errorCode;
      await atomic(statusFile, { version: 1, lastCheckedAt: iso(), lastSuccessAt: successful ? result.retrievedAt : previous.lastSuccessAt, errorCode: result.errorCode || "" });
    });
    statusLock = task.catch(() => {});
    return task;
  }
  function presentCache(info, configured, cached) {
    if (!cached.snapshot) return { ...base(info, configured), status: cached.lastAttempt?.status || base(info, configured).status,
      errorCode: cached.lastAttempt?.errorCode || base(info, configured).errorCode };
    const lastError = cached.lastAttempt?.errorCode || "";
    return { ...cached.snapshot, configured, cacheReused: true, networkAttempted: false,
      status: lastError ? "partial" : cached.snapshot.status, errorCode: lastError };
  }
  function normalizeResponse(payload, info, configured) {
    const value = info.value;
    if (!payload || payload.startDate !== value.startDate || payload.endDate !== value.endDate || payload.timeUnit !== "month") throw problem("PERIOD_MISMATCH");
    if (!Array.isArray(payload.results) || payload.results.length !== 1) throw problem("INVALID_RESPONSE");
    const group = payload.results[0];
    if (group.title !== value.keyword || !Array.isArray(group.keywords) || group.keywords.length !== 1 || group.keywords[0] !== value.keyword) throw problem("KEYWORD_MISMATCH");
    if (!Array.isArray(group.data) || group.data.length > 12) throw problem("INVALID_RESPONSE");
    const result = base(info, configured), allowed = new Set(result.series.map((point) => point.period)), found = new Map();
    for (const row of group.data) {
      if (!row || !allowed.has(row.period) || row.period > value.endDate || found.has(row.period)) throw problem("PERIOD_MISMATCH");
      // The official schema allows decimal strings; blanks, booleans and exponent notation are not observations.
      const ratio = typeof row.ratio === "string" && /^\d+(?:\.\d+)?$/.test(row.ratio) ? Number(row.ratio) : row.ratio;
      if (ratio !== null && ratio !== undefined && (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 100)) throw problem("INVALID_RESPONSE");
      found.set(row.period, ratio ?? null);
    }
    result.series = result.series.map((point) => {
      const ratio = found.get(point.period);
      return typeof ratio === "number" ? { ...point, ratio, value: ratio, status: "observed" } : point;
    });
    const complete = completePoints(result), observed = observedCount(result);
    return { ...result, status: complete ? value.partialMonth ? "partial" : "ready" : observed ? "partial" : "missing",
      retrievedAt: iso(), networkAttempted: true, errorCode: complete ? "" : observed ? "MISSING_VALUES" : "NO_DATA" };
  }
  async function request(info, credentials) {
    if (typeof fetchImpl !== "function") throw problem("NETWORK_ERROR");
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem("TIMEOUT")); }, timeoutMs); });
    const operation = (async () => {
      const response = await fetchImpl(ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal, headers: {
        "Content-Type": "application/json", "X-Naver-Client-Id": credentials.naverClientId, "X-Naver-Client-Secret": credentials.naverClientSecret
      }, body: JSON.stringify({ startDate: info.value.startDate, endDate: info.value.endDate, timeUnit: "month",
        keywordGroups: [{ groupName: info.value.keyword, keywords: [info.value.keyword] }] }) });
      if (!response?.ok) throw problem(response?.status === 429 ? "QUOTA_EXCEEDED" : [401, 403].includes(response?.status) ? "AUTH_ERROR" : "PROVIDER_FAILED");
      if (Number(response.headers?.get?.("content-length") || 0) > MAX_BODY) throw problem("RESPONSE_TOO_LARGE");
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), buffers = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw problem("RESPONSE_TOO_LARGE"); }
            buffers.push(Buffer.from(chunk.value));
          }
        } finally { reader.releaseLock(); }
        text = Buffer.concat(buffers).toString("utf8");
      } else {
        text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_BODY) throw problem("RESPONSE_TOO_LARGE");
      }
      let payload;
      try { payload = JSON.parse(text); } catch { throw problem("INVALID_RESPONSE"); }
      return normalizeResponse(payload, info, credentials.configured);
    })();
    try { return await Promise.race([operation, timeout]); }
    catch (error) { throw problem(safeCode(error)); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function get(input) {
    const info = await identity(input);
    let configured = false;
    try {
      configured = (await keys()).configured;
      if (info.publicationPending) return base(info, configured);
      return presentCache(info, configured, await readCache(info));
    } catch (error) { return { ...base(info, configured), status: "failed", errorCode: safeCode(error, "CACHE_READ_ERROR") }; }
  }
  async function refreshResolved(info) {
    let credentials, cached = { snapshot: null, lastAttempt: null }, result;
    try {
      credentials = await keys();
      if (info.publicationPending) return base(info, credentials.configured);
      cached = await readCache(info);
      const age = instant().getTime() - Date.parse(cached.snapshot?.retrievedAt || "");
      if (cached.snapshot && completePoints(cached.snapshot) && !cached.lastAttempt?.errorCode && age >= 0 && age <= TTL) return presentCache(info, credentials.configured, cached);
      if (!credentials.configured) result = { ...base(info, false), status: "failed", errorCode: "MISSING_KEY" };
      else result = await request(info, credentials);
    } catch (error) {
      result = { ...base(info, Boolean(credentials?.configured)), status: "failed", errorCode: safeCode(error), networkAttempted: Boolean(credentials?.configured) && !["CACHE_READ_ERROR", "CONFIG_READ_ERROR"].includes(safeCode(error)) };
      if (["CACHE_READ_ERROR", "CONFIG_READ_ERROR"].includes(result.errorCode)) return result;
    }
    const incoming = observedCount(result) > 0 ? result : null;
    const snapshot = !cached.snapshot || incoming && observedCount(incoming) >= observedCount(cached.snapshot) ? incoming : cached.snapshot;
    const output = snapshot && (!incoming || snapshot !== incoming)
      ? { ...snapshot, configured: Boolean(credentials?.configured), status: "partial", cacheReused: true,
        networkAttempted: result.networkAttempted, errorCode: result.errorCode || "MISSING_VALUES" } : result;
    try {
      await atomic(path.join(cacheDir, `${info.hash}.json`), { version: 1, identity: info.hash, snapshot,
        lastAttempt: { at: iso(), status: result.status, errorCode: result.errorCode || "" } });
      await rememberStatus(result);
      return clone(output);
    } catch {
      return { ...presentCache(info, Boolean(credentials?.configured), cached), status: cached.snapshot ? "partial" : "failed",
        networkAttempted: result.networkAttempted, errorCode: "CACHE_WRITE_ERROR" };
    }
  }
  async function refresh(input) {
    const info = await identity(input);
    if (flights.has(info.hash)) return clone(await flights.get(info.hash));
    const run = refreshResolved(info); flights.set(info.hash, run);
    try { return clone(await run); } finally { if (flights.get(info.hash) === run) flights.delete(info.hash); }
  }
  async function status() {
    let configured = false;
    try { configured = (await keys()).configured; return { configured, ...(await readStatus()), networkAttempted: false }; }
    catch (error) { return { configured, lastCheckedAt: "", lastSuccessAt: "", errorCode: safeCode(error, "CACHE_READ_ERROR"), networkAttempted: false }; }
  }
  return { get, refresh, status };
}

module.exports = { createRegionalSearchTrendService };
