"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");

const PROVIDERS = Object.freeze(["datalab", "searchad"]);
const KEY_FIELDS = Object.freeze({ datalab: ["naverClientId", "naverClientSecret"], searchad: ["searchadApiKey", "searchadSecretKey", "searchadCustomerId"] });
const MESSAGES = Object.freeze({
  OK: "테스트 응답을 정상 확인했습니다.", MISSING_KEY: "연결 키가 설정되지 않았습니다.", NOT_TESTED: "아직 연결 테스트 기록이 없습니다.",
  KEY_CHANGED: "키가 변경되어 다시 연결 테스트가 필요합니다.", AUTH_ERROR: "인증키 또는 API 이용 권한을 확인해 주세요.",
  QUOTA_EXCEEDED: "제공처의 요청 한도 또는 이용 제한을 확인해 주세요.", PROVIDER_UNAVAILABLE: "제공처 응답에 문제가 있습니다.",
  HTTP_ERROR: "제공처가 요청을 정상 처리하지 못했습니다.", INVALID_RESPONSE: "제공처 응답 형식을 확인하지 못했습니다.",
  NO_DATA: "응답은 받았지만 테스트 검색어의 자료가 없습니다.", TIMEOUT: "제공처 응답 시간이 초과됐습니다.",
  NETWORK_ERROR: "제공처에 연결하지 못했습니다.", CHECK_RECORD_UNAVAILABLE: "저장된 연결 테스트 기록을 확인하지 못했습니다.",
  CHECK_IN_PROGRESS: "연결 테스트 중입니다.", CHECK_INTERRUPTED: "이전 연결 테스트가 완료됐는지 확인하지 못했습니다.",
  CLOCK_SKEW: "연결 테스트 기록의 시각을 확인해 주세요."
});
const PERSISTED_STATES = new Set(["checking", "verified", "no_data", "failed", "limited"]);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const iso = value => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const configured = (provider, keys) => KEY_FIELDS[provider].every(field => Boolean(String(keys[field] || "").trim()));
const fingerprint = (provider, keys) => crypto.createHash("sha256").update(JSON.stringify(KEY_FIELDS[provider].map(field => String(keys[field] || "").trim()))).digest("hex");
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const failure = (checkStatus, errorCode, status = null) => ({ checkStatus, errorCode, status: safeStatus(status) });
function requestError(statusCode, code, message) { return Object.assign(new Error(message), { statusCode, code }); }

async function parseTrafficVerificationRequest(req, url) {
  if (url.searchParams.size) throw requestError(400, "TRAFFIC_VERIFY_INVALID_REQUEST", "연결 테스트 대상을 확인해 주세요.");
  if (req.headers.origin) {
    let origin; try { origin = new URL(req.headers.origin); } catch {}
    if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw requestError(403, "TRAFFIC_VERIFY_ORIGIN_REJECTED", "현재 데이터랩 화면에서 다시 요청해 주세요.");
    }
  }
  const contentType = String(req.headers["content-type"] || "");
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw requestError(415, "TRAFFIC_VERIFY_JSON_REQUIRED", "JSON 형식으로 요청해 주세요.");
  const declared = Number(req.headers["content-length"] || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > 512) throw requestError(413, "TRAFFIC_VERIFY_BODY_TOO_LARGE", "연결 테스트 요청이 너무 큽니다.");
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 512) throw requestError(413, "TRAFFIC_VERIFY_BODY_TOO_LARGE", "연결 테스트 요청이 너무 큽니다.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text && !contentType) throw requestError(415, "TRAFFIC_VERIFY_JSON_REQUIRED", "JSON 형식으로 요청해 주세요.");
  let payload; try { payload = text ? JSON.parse(text) : {}; } catch { throw requestError(400, "TRAFFIC_VERIFY_INVALID_REQUEST", "연결 테스트 대상을 확인해 주세요."); }
  if (!object(payload) || Object.keys(payload).some(key => key !== "provider") || (payload.provider !== undefined && ![...PROVIDERS, "all"].includes(payload.provider))) {
    throw requestError(400, "TRAFFIC_VERIFY_INVALID_REQUEST", "연결 테스트 대상을 확인해 주세요.");
  }
  return payload.provider || "all";
}

async function responseJson(response) {
  let text = "";
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        const buffer = Buffer.from(next.value); bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("BOUNDED_RESPONSE"); }
        chunks.push(buffer);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("BOUNDED_RESPONSE");
  }
  return JSON.parse(text);
}

async function probeConnection(provider, keys, { fetchImpl, now, signal }) {
  let url, options;
  if (provider === "datalab") {
    const end = new Date(now + 9 * 3600000); end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
    url = "https://openapi.naver.com/v1/datalab/search";
    options = { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", "X-Naver-Client-Id": keys.naverClientId, "X-Naver-Client-Secret": keys.naverClientSecret },
      body: JSON.stringify({ startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), timeUnit: "date", keywordGroups: [{ groupName: "글램핑", keywords: ["글램핑"] }] }) };
  } else {
    const timestamp = String(now), uri = "/keywordstool";
    url = "https://api.searchad.naver.com/keywordstool?hintKeywords=%EA%B8%80%EB%9E%A8%ED%95%91&showDetail=1";
    options = { method: "GET", redirect: "error", signal,
      headers: { "X-Timestamp": timestamp, "X-API-KEY": keys.searchadApiKey, "X-Customer": keys.searchadCustomerId,
        "X-Signature": crypto.createHmac("sha256", keys.searchadSecretKey).update(`${timestamp}.GET.${uri}`).digest("base64") } };
  }
  const response = await fetchImpl(url, options);
  const status = safeStatus(response?.status);
  if (status === 401 || status === 403) return failure("failed", "AUTH_ERROR", status);
  if (status === 429) return failure("limited", "QUOTA_EXCEEDED", status);
  if (status !== null && status >= 500) return failure("failed", "PROVIDER_UNAVAILABLE", status);
  if (status !== 200) return failure("failed", status === null ? "INVALID_RESPONSE" : "HTTP_ERROR", status);
  let data; try { data = await responseJson(response); } catch { return failure("failed", "INVALID_RESPONSE", status); }
  if (!object(data)) return failure("failed", "INVALID_RESPONSE", status);
  if (provider === "datalab") {
    if (!Array.isArray(data.results)) return failure("failed", "INVALID_RESPONSE", status);
    if (!data.results.length) return failure("no_data", "NO_DATA", status);
    const groups = data.results;
    if (!groups.every(group => object(group) && typeof group.title === "string" && group.title.replace(/\s+/g, "") === "글램핑" && Array.isArray(group.data))) return failure("failed", "INVALID_RESPONSE", status);
    const rows = groups.flatMap(group => group.data);
    if (!rows.length) return failure("no_data", "NO_DATA", status);
    const request = JSON.parse(options.body);
    if (!rows.every(row => object(row) && /^\d{4}-\d{2}-\d{2}$/.test(row.period || "") && row.period >= request.startDate && row.period <= request.endDate && typeof row.ratio === "number" && Number.isFinite(row.ratio) && row.ratio >= 0 && row.ratio <= 100)) return failure("failed", "INVALID_RESPONSE", status);
  } else {
    if (!Array.isArray(data.keywordList)) return failure("failed", "INVALID_RESPONSE", status);
    if (!data.keywordList.length) return failure("no_data", "NO_DATA", status);
    const count = value => typeof value === "number" ? Number.isFinite(value) && value >= 0 : typeof value === "string" && /^<?\s*\d+(?:\.\d+)?$/.test(value.replace(/,/g, "").trim());
    if (!data.keywordList.some(row => object(row) && typeof row.relKeyword === "string" && row.relKeyword.trim() && count(row.monthlyPcQcCnt) && count(row.monthlyMobileQcCnt))) return failure("failed", "INVALID_RESPONSE", status);
  }
  return { checkStatus: "verified", errorCode: "OK", status };
}

function createTrafficConnectionChecks({ filePath, readKeys, fetchImpl = (...args) => fetch(...args), clock = Date.now, timeoutMs = 15000, cooldownMs = 60000, freshnessMs = 24 * 3600000 } = {}) {
  if (!filePath || typeof readKeys !== "function" || typeof fetchImpl !== "function") throw new TypeError("Invalid traffic connection check dependencies");
  const location = path.resolve(filePath), inFlight = new Map(); let writes = Promise.resolve();
  const nowMs = () => { const value = Number(clock()); if (!Number.isFinite(value)) throw new Error("CLOCK_UNAVAILABLE"); return value; };
  const empty = () => ({ schemaVersion: 1, updatedAt: "", providers: {} });
  function resultConsistent(row) {
    if (row.checkStatus === "checking") return row.errorCode === "CHECK_IN_PROGRESS" && row.status === null && row.checkedAt === "";
    if (!iso(row.checkedAt) || Date.parse(row.checkedAt) < Date.parse(row.startedAt)) return false;
    if (row.checkStatus === "verified") return row.errorCode === "OK" && row.status === 200;
    if (row.checkStatus === "no_data") return row.errorCode === "NO_DATA" && row.status === 200;
    if (row.checkStatus === "limited") return row.errorCode === "QUOTA_EXCEEDED" && row.status === 429;
    if (row.checkStatus !== "failed") return false;
    if (row.errorCode === "AUTH_ERROR") return row.status === 401 || row.status === 403;
    if (row.errorCode === "PROVIDER_UNAVAILABLE") return row.status >= 500 && row.status <= 599;
    if (row.errorCode === "HTTP_ERROR") return safeStatus(row.status) !== null && ![200, 401, 403, 429].includes(row.status) && row.status < 500;
    if (row.errorCode === "INVALID_RESPONSE") return row.status === 200 || row.status === null;
    if (["TIMEOUT", "NETWORK_ERROR"].includes(row.errorCode)) return row.status === null;
    return false;
  }
  function recordValid(row) {
    return object(row) && Object.keys(row).every(key => ["fingerprint", "startedAt", "checkedAt", "checkStatus", "status", "errorCode"].includes(key))
      && /^[a-f0-9]{64}$/.test(row.fingerprint || "") && iso(row.startedAt) && (row.checkedAt === "" || iso(row.checkedAt))
      && PERSISTED_STATES.has(row.checkStatus) && Object.hasOwn(MESSAGES, row.errorCode) && (row.status === null || safeStatus(row.status) === row.status)
      && resultConsistent(row);
  }
  async function load() {
    let handle;
    try {
      const before = await fs.lstat(location);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_RECORD_BYTES) return { state: "unavailable", envelope: empty() };
      handle = await fs.open(location, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
      if (!same(before, await handle.stat())) return { state: "unavailable", envelope: empty() };
      const bytes = await handle.readFile();
      if (bytes.length > MAX_RECORD_BYTES || !same(before, await handle.stat()) || !same(before, await fs.lstat(location))) return { state: "unavailable", envelope: empty() };
      const envelope = JSON.parse(bytes.toString("utf8"));
      if (!object(envelope) || envelope.schemaVersion !== 1 || !object(envelope.providers) || Object.keys(envelope).some(key => !["schemaVersion", "updatedAt", "providers"].includes(key))
        || Object.keys(envelope.providers).some(key => !PROVIDERS.includes(key) || !recordValid(envelope.providers[key])) || !(envelope.updatedAt === "" || iso(envelope.updatedAt))) return { state: "unavailable", envelope: empty() };
      return { state: "ready", envelope };
    } catch (error) { return { state: error.code === "ENOENT" ? "missing" : "unavailable", envelope: empty() }; }
    finally { await handle?.close(); }
  }
  async function persist(update) {
    const operation = writes.then(async () => {
      const saved = await load();
      if (saved.state === "unavailable") throw new Error("CHECK_RECORD_UNAVAILABLE");
      const envelope = update(saved.envelope); envelope.updatedAt = new Date(nowMs()).toISOString();
      const directory = path.dirname(location); await fs.mkdir(directory, { recursive: true });
      const parent = await fs.lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("CHECK_RECORD_UNAVAILABLE");
      const temp = `${location}.${process.pid}.${crypto.randomUUID()}.tmp`; let handle;
      try {
        handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(JSON.stringify(envelope) + "\n"); await handle.sync(); await handle.close(); handle = null;
        try { const target = await fs.lstat(location); if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error("CHECK_RECORD_UNAVAILABLE"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        await fs.rename(temp, location);
      } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
    });
    writes = operation.catch(() => {}); return operation;
  }
  function publicCheck(provider, keys, saved, now) {
    const isConfigured = configured(provider, keys), row = saved.envelope.providers[provider];
    const base = { configured: isConfigured, ok: false, status: null, checkStatus: "unverified", errorCode: "NOT_TESTED", message: MESSAGES.NOT_TESTED,
      checkedAt: "", startedAt: "", validForCurrentKeys: false, stale: false, cooldownUntil: "" };
    const result = (state, code, fields = {}) => ({ ...base, ...fields, checkStatus: state, errorCode: code, message: MESSAGES[code] });
    if (!isConfigured) return result("not_configured", "MISSING_KEY");
    if (saved.state === "unavailable") return result("unknown", "CHECK_RECORD_UNAVAILABLE");
    if (!row) return base;
    const common = { checkedAt: row.checkedAt, startedAt: row.startedAt, status: row.status, cooldownUntil: new Date(Date.parse(row.startedAt) + cooldownMs).toISOString() };
    if (row.fingerprint !== fingerprint(provider, keys)) return result("key_changed", "KEY_CHANGED", { ...common, stale: true });
    if (Date.parse(row.startedAt) > now || row.checkedAt && Date.parse(row.checkedAt) > now) return result("unknown", "CLOCK_SKEW", { ...common, stale: true, validForCurrentKeys: true });
    if (row.checkStatus === "checking") return result(inFlight.has(provider) ? "checking" : "unknown", inFlight.has(provider) ? "CHECK_IN_PROGRESS" : "CHECK_INTERRUPTED", { ...common, validForCurrentKeys: true });
    return result(row.checkStatus, row.errorCode, { ...common, ok: row.checkStatus === "verified", validForCurrentKeys: true, stale: now - Date.parse(row.checkedAt) >= freshnessMs });
  }
  async function status(keys) {
    const effectiveKeys = keys || await readKeys(), saved = await load(), now = nowMs();
    const checks = Object.fromEntries(PROVIDERS.map(provider => [provider, publicCheck(provider, effectiveKeys, saved, now)]));
    const checkedAt = Object.values(checks).map(check => check.checkedAt).filter(iso).sort().at(-1) || "";
    return { keyword: "글램핑", checkedAt, recordState: saved.state, ...checks };
  }
  async function checkOne(provider, keys) {
    if (!configured(provider, keys)) return { provider, performed: false, reason: "MISSING_KEY" };
    if (inFlight.has(provider)) { const result = await inFlight.get(provider); return { ...result, shared: true }; }
    const operation = (async () => {
      const saved = await load(), now = nowMs(), prior = saved.envelope.providers[provider];
      if (saved.state === "unavailable") return { provider, performed: false, reason: "CHECK_RECORD_UNAVAILABLE" };
      if (prior && now < Date.parse(prior.startedAt) + cooldownMs) return { provider, performed: false, reason: "COOLDOWN" };
      const claim = { fingerprint: fingerprint(provider, keys), startedAt: new Date(now).toISOString(), checkedAt: "", checkStatus: "checking", status: null, errorCode: "CHECK_IN_PROGRESS" };
      try { await persist(envelope => ({ ...envelope, providers: { ...envelope.providers, [provider]: claim } })); }
      catch { return { provider, performed: false, reason: "CHECK_RECORD_UNAVAILABLE" }; }
      const controller = new AbortController(); let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure("failed", "TIMEOUT")); }, timeoutMs); });
      let result;
      try { result = await Promise.race([probeConnection(provider, keys, { fetchImpl, now, signal: controller.signal }).catch(() => failure("failed", controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR")), timeout]); }
      finally { clearTimeout(timer); }
      const completed = { ...claim, ...result, checkedAt: new Date(nowMs()).toISOString() };
      try { await persist(envelope => ({ ...envelope, providers: { ...envelope.providers, [provider]: completed } })); }
      catch { return { provider, performed: true, reason: "CHECK_RECORD_UNAVAILABLE" }; }
      return { provider, performed: true, reason: result.errorCode };
    })();
    inFlight.set(provider, operation);
    try { return await operation; } finally { if (inFlight.get(provider) === operation) inFlight.delete(provider); }
  }
  async function verify(provider = "all") {
    if (![...PROVIDERS, "all"].includes(provider)) throw requestError(400, "TRAFFIC_VERIFY_INVALID_REQUEST", "연결 테스트 대상을 확인해 주세요.");
    const keys = await readKeys(), targets = provider === "all" ? PROVIDERS : [provider];
    const attempts = await Promise.all(targets.map(target => checkOne(target, keys)));
    return { ...await status(), test: { requestedProviders: [...targets], attempts, testSkipped: attempts.every(attempt => !attempt.performed) } };
  }
  return { status, verify };
}

module.exports = { createTrafficConnectionChecks, parseTrafficVerificationRequest };
