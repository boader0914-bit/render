"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const SOURCE = Object.freeze({ id: "kasi-special-days", name: "한국천문연구원 특일정보", url: "https://www.data.go.kr/data/15012690/openapi.do" });
const BASE_URL = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService";
const CATEGORIES = Object.freeze([
  { kind: "holidays", label: "공휴일", operation: "getRestDeInfo" },
  { kind: "nationalDays", label: "국경일", operation: "getHoliDeInfo" },
  { kind: "anniversaries", label: "기념일", operation: "getAnniversaryInfo" },
  { kind: "solarTerms", label: "24절기", operation: "get24DivisionsInfo" },
  { kind: "sundryDays", label: "잡절", operation: "getSundryDayInfo" }
].map(category => Object.freeze(category)));
const TTL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ERROR_MESSAGES = Object.freeze({
  MISSING_KEY: "특일정보 인증키가 설정되지 않았습니다.",
  AUTH_ERROR: "특일정보 활용신청 승인과 인증키를 확인해 주세요.",
  QUOTA_EXCEEDED: "특일정보 호출 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.",
  SERVICE_UNAVAILABLE: "특일정보 제공기관에서 정상 응답을 받지 못했습니다.",
  INVALID_RESPONSE: "특일정보 응답의 날짜 또는 페이지 구성을 확인하지 못했습니다.",
  TIMEOUT: "특일정보 응답 대기시간을 초과했습니다.",
  NETWORK_ERROR: "특일정보 제공기관에 연결하지 못했습니다.",
  CACHE_READ_ERROR: "저장된 특일정보를 읽지 못했습니다.",
  CACHE_WRITE_ERROR: "특일정보 저장에 실패하여 이전 저장 자료를 유지합니다.",
  NOT_COLLECTED: "아직 수집한 특일정보가 없습니다."
});

function problem(code) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  error.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "SERVICE_UNAVAILABLE";
  return error;
}
function publicError(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : "NETWORK_ERROR";
  return { code, message: ERROR_MESSAGES[code] };
}
function validateYear(value) {
  const year = typeof value === "number" ? value : (/^\d{4}$/.test(String(value)) ? Number(value) : NaN);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    const error = new Error("조회 연도는 2000년부터 2100년까지 입력해 주세요.");
    error.code = "INVALID_YEAR";
    error.statusCode = 400;
    throw error;
  }
  return year;
}
function normalizeServiceKey(value) {
  if (typeof value !== "string") return "";
  let key = value.trim();
  // The portal supplies both encoded and decoded forms. Encode exactly once.
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { return ""; }
  }
  return key;
}
function providerError(code) {
  const value = String(code || "").trim();
  if (["20", "21", "30", "31", "32"].includes(value)) return problem("AUTH_ERROR");
  if (["22", "23"].includes(value)) return problem("QUOTA_EXCEEDED");
  return problem("SERVICE_UNAVAILABLE");
}
function xmlText(value) {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, entity) => {
    if (entity[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity.toLowerCase()];
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw problem("INVALID_RESPONSE");
    return String.fromCodePoint(point);
  }).trim();
}
function xmlTag(text, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`).exec(text);
  return match ? match[1] : null;
}
function xmlLeaf(text, name) {
  const value = xmlTag(text, name);
  if (value === null) return undefined;
  if (/<(?!\!\[CDATA\[)/.test(value.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) throw problem("INVALID_RESPONSE");
  return xmlText(value);
}
function parseXml(text) {
  // This restricted parser reads only the documented flat response schema. It
  // neither resolves entities nor accepts DTDs, external resources or HTML.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw problem("INVALID_RESPONSE");
  const gateway = xmlTag(text, "cmmMsgHeader");
  if (gateway !== null) throw providerError(xmlLeaf(gateway, "returnReasonCode"));
  const response = xmlTag(text, "response");
  if (response === null) throw problem("INVALID_RESPONSE");
  const header = xmlTag(response, "header");
  const body = xmlTag(response, "body");
  if (header === null) throw problem("INVALID_RESPONSE");
  const resultCode = xmlLeaf(header, "resultCode");
  if (resultCode !== "00") throw providerError(resultCode);
  if (body === null) throw problem("INVALID_RESPONSE");
  const itemsXml = xmlTag(body, "items") || "";
  const items = [...itemsXml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/g)].map((match) => {
    const row = {};
    for (const field of ["locdate", "dateName", "isHoliday", "seq", "dateKind", "kst", "sunLongitude"]) row[field] = xmlLeaf(match[1], field);
    return row;
  });
  return { items, totalCount: xmlLeaf(body, "totalCount"), pageNo: xmlLeaf(body, "pageNo"), numOfRows: xmlLeaf(body, "numOfRows") };
}
function integerField(value, min) {
  if (value === null || value === undefined || !/^\d+$/.test(String(value))) throw problem("INVALID_RESPONSE");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min) throw problem("INVALID_RESPONSE");
  return result;
}
function parseResponse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw problem("INVALID_RESPONSE");
  const bodyText = text.replace(/^\uFEFF/, "").trim();
  let parsed;
  if (bodyText.startsWith("<")) parsed = parseXml(bodyText);
  else {
    let payload;
    try { payload = JSON.parse(bodyText); } catch { throw problem("INVALID_RESPONSE"); }
    const response = payload?.response;
    if (!response || !response.header || response.header.resultCode === undefined) throw problem("INVALID_RESPONSE");
    if (!["00", "0"].includes(String(response.header.resultCode))) throw providerError(response.header.resultCode);
    const body = response.body;
    if (!body || typeof body !== "object") throw problem("INVALID_RESPONSE");
    const value = body.items?.item;
    const items = value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]);
    parsed = { items, totalCount: body.totalCount, pageNo: body.pageNo, numOfRows: body.numOfRows };
  }
  return { items: parsed.items, totalCount: integerField(parsed.totalCount, 0), pageNo: integerField(parsed.pageNo, 1), numOfRows: integerField(parsed.numOfRows, 1) };
}
function normalizeItem(row, category, year) {
  if (!row || typeof row !== "object") throw problem("INVALID_RESPONSE");
  const dateText = String(row.locdate ?? "");
  if (!/^\d{8}$/.test(dateText)) throw problem("INVALID_RESPONSE");
  const date = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || Number(dateText.slice(0, 4)) !== year) throw problem("INVALID_RESPONSE");
  const name = typeof row.dateName === "string" ? row.dateName.trim() : "";
  if (!name || name.length > 200 || !["Y", "N"].includes(row.isHoliday)) throw problem("INVALID_RESPONSE");
  return { date, name, kind: category.kind, kindLabel: category.label, isHoliday: row.isHoliday === "Y", seq: String(row.seq ?? ""), dateKind: String(row.dateKind ?? ""), kst: row.kst === undefined || row.kst === null ? null : String(row.kst), sunLongitude: row.sunLongitude === undefined || row.sunLongitude === null ? null : String(row.sunLongitude) };
}

function createSpecialDaysService({ dataDir, readServiceKey, fetchImpl = globalThis.fetch, timeoutMs = 12000, now = () => Date.now() } = {}) {
  if (!dataDir || typeof readServiceKey !== "function" || typeof fetchImpl !== "function") throw new TypeError("특일정보 저장 경로와 인증키 조회 함수가 필요합니다.");
  const directory = path.resolve(dataDir);
  const attempts = new Map();
  const inFlight = new Map();
  let lastVerification = null;
  const at = () => Number(now());
  const iso = () => new Date(at()).toISOString();
  const cacheFile = year => path.join(directory, `special-days-${year}.json`);
  async function key() {
    try { return normalizeServiceKey(await readServiceKey()); } catch { return ""; }
  }
  async function readCache(year) {
    try {
      const value = JSON.parse(await fs.readFile(cacheFile(year), "utf8"));
      if (value.version !== 1 || value.year !== year || !value.categories || typeof value.categories !== "object") throw problem("CACHE_READ_ERROR");
      const categories = {};
      for (const category of CATEGORIES) {
        const cached = value.categories[category.kind];
        if (!cached) continue;
        if (!Array.isArray(cached.items) || !Number.isFinite(Date.parse(cached.updatedAt))) throw problem("CACHE_READ_ERROR");
        const items = cached.items.map(item => normalizeItem({ locdate: String(item.date).replace(/-/g, ""), dateName: item.name, isHoliday: item.isHoliday === true ? "Y" : item.isHoliday === false ? "N" : "", seq: item.seq, dateKind: item.dateKind, kst: item.kst, sunLongitude: item.sunLongitude }, category, year));
        categories[category.kind] = { updatedAt: cached.updatedAt, items };
      }
      return { version: 1, year, categories };
    } catch (error) {
      return { version: 1, year, categories: {}, readError: error.code === "ENOENT" ? null : publicError(problem("CACHE_READ_ERROR")) };
    }
  }
  async function saveCache(cache) {
    const temporary = `${cacheFile(cache.year)}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, year: cache.year, categories: cache.categories }), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, cacheFile(cache.year));
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw problem("CACHE_WRITE_ERROR");
    }
  }
  async function requestPage(category, year, serviceKey, pageNo, pageSize = 100) {
    const url = new URL(`${BASE_URL}/${category.operation}`);
    url.searchParams.set("ServiceKey", serviceKey);
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", String(pageSize));
    url.searchParams.set("_type", "json");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Accept: "application/json, application/xml;q=0.9" }, redirect: "error" });
          if (response.status === 401 || response.status === 403) throw problem("AUTH_ERROR");
          if (response.status === 429) throw problem("QUOTA_EXCEEDED");
          if (!response.ok) throw problem("SERVICE_UNAVAILABLE");
          const page = parseResponse(await response.text());
          if (page.pageNo !== pageNo || page.items.length > page.numOfRows || page.items.length > page.totalCount) throw problem("INVALID_RESPONSE");
          return page;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem("TIMEOUT")); }, Math.max(1, timeoutMs)); })
      ]);
    } catch (error) {
      throw problem(publicError(error).code);
    } finally { clearTimeout(timer); }
  }
  async function collectCategory(category, year, serviceKey) {
    const items = [];
    const identities = new Set();
    let expectedCount = null;
    for (let pageNo = 1; pageNo <= 50; pageNo++) {
      const page = await requestPage(category, year, serviceKey, pageNo);
      if (expectedCount === null) expectedCount = page.totalCount;
      if (expectedCount !== page.totalCount || expectedCount > 5000 || (page.items.length === 0 && items.length < expectedCount)) throw problem("INVALID_RESPONSE");
      for (const row of page.items) {
        const item = normalizeItem(row, category, year);
        const identity = JSON.stringify([item.date, item.seq, item.name]);
        // Distinct names/sequences on the same day remain distinct events. An
        // identical event returned again is an incomplete/repeated page.
        if (identities.has(identity)) throw problem("INVALID_RESPONSE");
        identities.add(identity);
        items.push(item);
      }
      if (items.length > expectedCount) throw problem("INVALID_RESPONSE");
      if (items.length === expectedCount) return items.sort((a, b) => a.date.localeCompare(b.date) || a.seq.localeCompare(b.seq));
    }
    throw problem("INVALID_RESPONSE");
  }
  function resultFor(cache, configured, networkAttempted = false) {
    const categories = {};
    for (const category of CATEGORIES) {
      const cached = cache.categories[category.kind];
      const attempt = attempts.get(`${cache.year}:${category.kind}`);
      const error = attempt?.error || (!cached ? (configured ? cache.readError || publicError(problem("NOT_COLLECTED")) : publicError(problem("MISSING_KEY"))) : null);
      const stale = Boolean(cached && (at() - Date.parse(cached.updatedAt) >= TTL_MS || error));
      categories[category.kind] = { ...category, status: cached ? (stale ? "stale" : "ready") : (!configured ? "missing_key" : "error"), count: cached?.items.length || 0, updatedAt: cached?.updatedAt || null, stale, error, items: cached?.items || [] };
    }
    const values = Object.values(categories);
    const items = values.flatMap(category => category.items).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.seq.localeCompare(b.seq));
    const stamps = values.map(category => category.updatedAt).filter(Boolean).sort();
    return { year: cache.year, configured, status: values.every(category => category.status === "ready") ? "ready" : (stamps.length ? "partial" : (!configured ? "missing_key" : "error")), source: { ...SOURCE }, updatedAt: stamps[0] || null, stale: values.some(category => category.stale), items, holidays: categories.holidays.items.filter(item => item.isHoliday), categories, errors: values.filter(category => category.error).map(category => ({ kind: category.kind, ...category.error })), networkAttempted };
  }
  async function loadYear(year, refresh) {
    let cache = await readCache(year);
    const serviceKey = await key();
    let networkAttempted = false;
    for (const category of CATEGORIES) {
      const cached = cache.categories[category.kind];
      const identity = `${year}:${category.kind}`;
      const attempt = attempts.get(identity);
      if (!refresh && cached && !attempt?.error && at() - Date.parse(cached.updatedAt) < TTL_MS) continue;
      if (!refresh && attempt?.error && at() - attempt.at < COOLDOWN_MS) continue;
      if (!serviceKey) continue;
      networkAttempted = true;
      try {
        const items = await collectCategory(category, year, serviceKey);
        const next = { ...cache, categories: { ...cache.categories, [category.kind]: { updatedAt: iso(), items } } };
        await saveCache(next);
        cache = next;
        attempts.set(identity, { at: at(), error: null });
      } catch (error) { attempts.set(identity, { at: at(), error: publicError(error) }); }
    }
    return resultFor(cache, Boolean(serviceKey), networkAttempted);
  }
  async function getYear(value = new Date(at() + 9 * 60 * 60 * 1000).getUTCFullYear(), { refresh = false } = {}) {
    const year = validateYear(value);
    if (inFlight.has(year)) return inFlight.get(year);
    const pending = loadYear(year, refresh === true);
    inFlight.set(year, pending);
    try { return await pending; } finally { inFlight.delete(year); }
  }
  async function verify(value = new Date(at() + 9 * 60 * 60 * 1000).getUTCFullYear()) {
    const year = validateYear(value);
    const serviceKey = await key();
    let error = null;
    if (!serviceKey) error = publicError(problem("MISSING_KEY"));
    else {
      try {
        const page = await requestPage(CATEGORIES[0], year, serviceKey, 1, 1);
        if (page.totalCount > 0 && !page.items.length) throw problem("INVALID_RESPONSE");
        page.items.forEach(row => normalizeItem(row, CATEGORIES[0], year));
      } catch (failure) { error = publicError(failure); }
    }
    lastVerification = { ok: !error, year, checkedAt: iso(), status: error ? (serviceKey ? "error" : "missing_key") : "ready", error, source: { ...SOURCE } };
    return { ...lastVerification };
  }
  async function status(value) {
    const year = value === undefined ? null : validateYear(value);
    const configured = Boolean(await key());
    const filenames = await fs.readdir(directory).catch(() => []);
    const cachedYears = [];
    for (const filename of filenames.filter(name => /^special-days-\d{4}\.json$/.test(name))) {
      const candidate = Number(filename.slice(13, 17));
      if (candidate < 2000 || candidate > 2100) continue;
      const result = resultFor(await readCache(candidate), configured);
      if (result.updatedAt) cachedYears.push({ year: candidate, updatedAt: result.updatedAt, count: result.items.length, stale: result.stale });
    }
    return { configured, source: { ...SOURCE }, cacheTtlHours: 24, retryCooldownSeconds: 300, supportedYears: { min: 2000, max: 2100 }, categories: CATEGORIES.map(category => ({ ...category })), cachedYears: cachedYears.sort((a, b) => a.year - b.year), lastVerification: lastVerification ? { ...lastVerification } : null, ...(year === null ? {} : { yearStatus: resultFor(await readCache(year), configured) }) };
  }
  return { status, getYear, verify };
}

module.exports = { createSpecialDaysService, validateYear, parseResponse, SOURCE, CATEGORIES };
