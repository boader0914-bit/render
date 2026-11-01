"use strict";

const crypto = require("node:crypto");
const { resolveDatalabConnection } = require("./naver_datalab_connection.cjs");
const { normalizeKeyword, normalizeSearchAdSnapshot, normalizeTrendSnapshot } = require("./search_demand_model.cjs");

const MAX_BYTES = Object.freeze({ searchad: 2 * 1024 * 1024, datalab: 256 * 1024 });
const CODES = new Set(["INVALID_REQUEST", "MISSING_KEY", "CONFIG_READ_ERROR", "CREDENTIAL_SCOPE_CHANGED", "AUTH_ERROR", "QUOTA_EXCEEDED",
  "HTTP_ERROR", "PROVIDER_UNAVAILABLE", "INVALID_RESPONSE", "INVALID_JSON", "RESPONSE_TOO_LARGE", "RESPONSE_READ_ERROR", "TIMEOUT", "NETWORK_ERROR",
  "INVALID_KEYWORD", "INVALID_DATE", "INVALID_PERIOD", "KEYWORD_MISMATCH", "PERIOD_MISMATCH", "NO_EXACT_KEYWORD", "INCOMPLETE_DATA"]);
const stamp = value => new Date(typeof value === "function" ? value() : value).toISOString();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const failure = code => Object.assign(new Error("검색 자료 응답을 확인하지 못했습니다."), { code });
function safeError(error, fallback = "INVALID_RESPONSE") { return CODES.has(error?.code) ? error.code : fallback; }
function fullDate(value) {
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function credentialConnection(provider, keys) {
  if (provider === "datalab") return resolveDatalabConnection(keys);
  const credentialFields = ["searchadApiKey", "searchadSecretKey", "searchadCustomerId"];
  const values = credentialFields.map(field => typeof keys?.[field] === "string" ? keys[field].trim() : "");
  return { provider: "searchad", configured: values.every(Boolean), credentialFields, values };
}
function scopeOf(provider, connection, keys) {
  if (!connection.configured) return null;
  return "sdscope_" + crypto.createHash("sha256").update(JSON.stringify(["search-demand-credentials-v1", provider, connection.provider,
    ...connection.credentialFields.map(field => keys[field].trim())])).digest("hex");
}

async function boundedJson(response, maximum, progress) {
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        const chunk = Buffer.from(next.value); progress.responseBytes += chunk.length;
        if (progress.responseBytes > maximum) { try { await reader.cancel(); } catch {} throw failure("RESPONSE_TOO_LARGE"); }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } catch (error) { throw failure(error?.code === "RESPONSE_TOO_LARGE" ? error.code : "RESPONSE_READ_ERROR"); }
    finally { try { reader.releaseLock(); } catch {} }
  } else {
    try { bytes = Buffer.from(await response.text(), "utf8"); } catch { throw failure("RESPONSE_READ_ERROR"); }
    progress.responseBytes = bytes.length;
    if (bytes.length > maximum) throw failure("RESPONSE_TOO_LARGE");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw failure("INVALID_JSON"); }
}

function createSearchDemandProviders({ readKeys, fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 15000,
  maxResponseBytes = MAX_BYTES, minIntervalMs = 350, waitImpl = delay } = {}) {
  if (typeof readKeys !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function" || typeof waitImpl !== "function"
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000 || !Number.isFinite(minIntervalMs) || minIntervalMs < 350) throw new TypeError("Invalid search demand provider dependencies");
  const limits = Object.fromEntries(Object.entries(MAX_BYTES).map(([provider, upper]) => {
    const value = typeof maxResponseBytes === "number" ? maxResponseBytes : maxResponseBytes?.[provider] ?? upper;
    if (!Number.isSafeInteger(value) || value <= 0 || value > upper) throw new TypeError("Invalid search demand response bound");
    return [provider, value];
  }));
  const lanes = new Map(), counters = { searchad: { calls: 0, failed: 0 }, datalab: { calls: 0, failed: 0 } };
  async function credentials(provider) {
    let keys;
    try { keys = await readKeys(); } catch { throw failure("CONFIG_READ_ERROR"); }
    const connection = credentialConnection(provider, keys);
    return { keys, connection, scopeId: scopeOf(provider, connection, keys) };
  }
  async function credentialScope(provider) {
    if (!["searchad", "datalab"].includes(provider)) throw failure("INVALID_REQUEST");
    try {
      const value = await credentials(provider);
      return { configured: value.connection.configured, scopeId: value.scopeId, connectionProvider: value.connection.provider };
    } catch { return { configured: false, scopeId: null, connectionProvider: null, errorCode: "CONFIG_READ_ERROR" }; }
  }
  async function serialized(host, work) {
    let lane = lanes.get(host);
    if (!lane) { lane = { pending: Promise.resolve(), lastStartedAt: null }; lanes.set(host, lane); }
    const operation = lane.pending.then(async () => {
      const current = Date.parse(stamp(clock));
      if (lane.lastStartedAt !== null && current < lane.lastStartedAt + minIntervalMs) await waitImpl(lane.lastStartedAt + minIntervalMs - current);
      const started = Date.parse(stamp(clock));
      lane.lastStartedAt = lane.lastStartedAt === null ? started : Math.max(started, lane.lastStartedAt + minIntervalMs);
      return work();
    });
    lane.pending = operation.catch(() => {}); return operation;
  }
  async function collect(provider, input) {
    const initial = stamp(clock), base = { provider, requestedAt: initial, observedAt: initial, networkAttempted: false, requestCount: 0, httpStatus: null };
    let identity, credential;
    try {
      identity = normalizeKeyword(input?.keyword);
      if (!identity?.keywordId) throw failure("INVALID_KEYWORD");
      if (provider === "datalab" && (!fullDate(input.startDate) || !fullDate(input.endDate) || input.startDate > input.endDate
        || !input.startDate.endsWith("-01") || input.startDate < "2016-01-01"
        || !new Date(Date.parse(`${input.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).endsWith("-01")
        || input.endDate >= new Date(Date.parse(initial) + 9 * 3600000).toISOString().slice(0, 7) + "-01")) throw failure("INVALID_PERIOD");
      if (provider === "datalab" && (Number(input.endDate.slice(0, 4)) - Number(input.startDate.slice(0, 4))) * 12
        + Number(input.endDate.slice(5, 7)) - Number(input.startDate.slice(5, 7)) >= 24) throw failure("INVALID_PERIOD");
      credential = await credentials(provider);
      if (!credential.connection.configured) throw failure("MISSING_KEY");
      if (input.scopeId !== undefined && input.scopeId !== credential.scopeId) throw failure("CREDENTIAL_SCOPE_CHANGED");
    } catch (error) { return { ...base, status: "held", errorCode: safeError(error, "INVALID_REQUEST") }; }
    const host = provider === "searchad" ? "api.searchad.naver.com" : new URL(credential.connection.endpoint).host;
    return serialized(host, async () => {
      const requestedAt = stamp(clock), controller = new AbortController(), progress = { responseBytes: 0 };
      let timer, httpStatus = null;
      const metadata = { ...base, requestedAt, networkAttempted: true, requestCount: 1 };
      const operation = (async () => {
        let endpoint, options;
        if (provider === "searchad") {
          const timestamp = String(Date.parse(requestedAt)), uri = "/keywordstool", [apiKey, secretKey, customerId] = credential.connection.values;
          endpoint = `https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(identity.normalized)}&showDetail=1`;
          options = { method: "GET", headers: { "X-Timestamp": timestamp, "X-API-KEY": apiKey, "X-Customer": customerId,
            "X-Signature": crypto.createHmac("sha256", secretKey).update(`${timestamp}.GET.${uri}`).digest("base64") } };
        } else {
          endpoint = credential.connection.endpoint;
          options = { method: "POST", headers: credential.connection.headers, body: JSON.stringify({ startDate: input.startDate, endDate: input.endDate,
            timeUnit: "month", keywordGroups: [{ groupName: identity.keyword, keywords: [identity.keyword] }] }) };
        }
        counters[provider].calls++;
        const response = await fetchImpl(endpoint, { ...options, redirect: "error", signal: controller.signal });
        httpStatus = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        if ([401, 403].includes(httpStatus)) throw failure("AUTH_ERROR");
        if (httpStatus === 429) throw failure("QUOTA_EXCEEDED");
        if (httpStatus !== 200) throw failure(httpStatus >= 500 ? "PROVIDER_UNAVAILABLE" : "HTTP_ERROR");
        const payload = await boundedJson(response, limits[provider], progress), observedAt = stamp(clock);
        const arguments_ = { keyword: identity.keyword, scopeId: credential.scopeId, observedAt,
          requestId: "sdreq_" + crypto.randomUUID().replaceAll("-", "") };
        let snapshot;
        try {
          if (provider === "searchad") {
            if (!payload || typeof payload !== "object" || !Array.isArray(payload.keywordList)) throw failure("INVALID_RESPONSE");
            snapshot = normalizeSearchAdSnapshot({ ...arguments_, keywordList: payload.keywordList });
          } else {
            if (!payload || payload.startDate !== input.startDate || payload.endDate !== input.endDate || payload.timeUnit !== "month"
              || !Array.isArray(payload.results)) throw failure("PERIOD_MISMATCH");
            if (payload.results.length > 1) throw failure("INVALID_RESPONSE");
            const group = payload.results[0];
            if (group && (!Array.isArray(group.keywords) || group.keywords.length !== 1 || normalizeKeyword(group.title).keywordId !== identity.keywordId
              || normalizeKeyword(group.keywords[0]).keywordId !== identity.keywordId)) throw failure("KEYWORD_MISMATCH");
            snapshot = normalizeTrendSnapshot({ ...arguments_, startDate: input.startDate, endDate: input.endDate, timeUnit: "month",
              results: payload.results, connectionProvider: credential.connection.provider });
          }
        } catch (error) { throw failure(safeError(error, "INVALID_RESPONSE")); }
        return { ...metadata, observedAt, httpStatus, status: snapshot.status === "ready" ? "complete" : "held",
          errorCode: snapshot.status === "ready" ? null : provider === "searchad" && !snapshot.anchor ? "NO_EXACT_KEYWORD" : "INCOMPLETE_DATA",
          diagnostics: { responseBytes: progress.responseBytes }, snapshot };
      })();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("TIMEOUT")); }, timeoutMs); });
      try { return await Promise.race([operation, timeout]); }
      catch (error) {
        counters[provider].failed++;
        const errorCode = controller.signal.aborted ? "TIMEOUT" : safeError(error, "NETWORK_ERROR");
        return { ...metadata, observedAt: stamp(clock), httpStatus, status: ["AUTH_ERROR", "QUOTA_EXCEEDED"].includes(errorCode) ? "blocked" : "failed",
          errorCode, diagnostics: { responseBytes: progress.responseBytes } };
      } finally { clearTimeout(timer); controller.abort(); }
    });
  }
  return {
    searchad: input => collect("searchad", input), datalab: input => collect("datalab", input), credentialScope,
    status: () => ({ scope: "search-demand-provider-adapter", providers: structuredClone(counters), minIntervalMs, timeoutMs,
      responseLimits: { ...limits }, automaticRetries: false })
  };
}

module.exports = { createSearchDemandProviders };
