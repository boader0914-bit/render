"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const codebook = require("../../web/data/tourism_forecast_regions.json");

const SOURCE = Object.freeze({ id: "kto-tourism-forecast", name: "한국관광공사 관광지 집중률 예측", url: "https://www.data.go.kr/data/15128555/openapi.do" });
const ENDPOINT = "https://apis.data.go.kr/B551011/TatsCnctrRateService/tatsCnctrRatedList";
const DAY_MS = 86400000;
const COOLDOWN_MS = 300000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REGIONS = codebook.regions.map(region => Object.freeze({ ...region }));
const REGION_MAP = new Map(REGIONS.map(region => [`${region.areaCd}:${region.signguCd}`, region]));
const MESSAGES = Object.freeze({
  MISSING_KEY: "관광지 집중률 예측 인증키가 설정되지 않았습니다.",
  AUTH_ERROR: "관광지 집중률 예측 API의 활용신청 승인과 인증키를 확인해 주세요.",
  QUOTA_EXCEEDED: "관광지 집중률 예측 호출 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.",
  SERVICE_UNAVAILABLE: "관광지 집중률 예측 제공기관에서 정상 응답을 받지 못했습니다.",
  INVALID_RESPONSE: "관광지 예측의 지역·날짜·집중률 또는 페이지 구성을 확인하지 못했습니다.",
  STALE_RESPONSE: "기존 자료보다 이전 기간의 예측이 반환되어 저장 자료를 유지합니다.",
  NO_DATA: "제공기관에 해당 지역의 관광지 예측 자료가 없습니다.",
  TIMEOUT: "관광지 집중률 예측 응답 대기시간을 초과했습니다.",
  NETWORK_ERROR: "관광지 집중률 예측 제공기관에 연결하지 못했습니다.",
  CACHE_READ_ERROR: "저장된 관광지 예측 자료를 읽지 못했습니다.",
  CACHE_WRITE_ERROR: "관광지 예측 자료를 저장하지 못해 이전 자료를 유지합니다.",
  NOT_COLLECTED: "아직 해당 지역의 관광지 예측 자료를 조회하지 않았습니다."
});
function failure(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.SERVICE_UNAVAILABLE);
  error.code = Object.hasOwn(MESSAGES, code) ? code : "SERVICE_UNAVAILABLE";
  return error;
}
function publicError(error) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : "NETWORK_ERROR";
  return { code, message: MESSAGES[code] };
}
function kstDate(timestamp) { return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10); }
function dayNumber(date) { return Date.parse(`${date}T00:00:00Z`) / DAY_MS; }
function dateString(value) {
  const text = String(value ?? "");
  const date = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date || Number(date.slice(0, 4)) < 2000 || Number(date.slice(0, 4)) > 2100) throw failure("INVALID_RESPONSE");
  return date;
}
function validateRegion(input = {}) {
  const areaCd = String(input?.areaCd ?? "");
  const signguCd = String(input?.signguCd ?? "");
  const region = /^\d{2}$/.test(areaCd) && /^\d{5}$/.test(signguCd) ? REGION_MAP.get(`${areaCd}:${signguCd}`) : null;
  if (!region) {
    const error = new Error("공식 코드표의 시도와 시군구를 선택해 주세요.");
    error.code = "INVALID_REGION";
    error.statusCode = 400;
    throw error;
  }
  return { ...region };
}
function serviceKey(value) {
  if (typeof value !== "string") return "";
  let key = value.trim();
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { return ""; }
  }
  return key;
}
function providerError(code) {
  const value = /^\d+$/.test(String(code)) ? Number(code) : -1;
  if (value === 3) return failure("NO_DATA");
  if ([20, 21, 30, 31, 32, 33].includes(value)) return failure("AUTH_ERROR");
  if ([22, 23].includes(value)) return failure("QUOTA_EXCEEDED");
  return failure("SERVICE_UNAVAILABLE");
}
function xmlTag(text, name) {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`).exec(text)?.[1] ?? null;
}
function xmlLeaf(text, name) {
  const textValue = xmlTag(text, name);
  if (textValue === null) return undefined;
  if (/<(?!\!\[CDATA\[)/.test(textValue.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) throw failure("INVALID_RESPONSE");
  return textValue.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity.toLowerCase()];
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw failure("INVALID_RESPONSE");
    return String.fromCodePoint(point);
  }).trim();
}
function integer(value, minimum) {
  if (!/^\d+$/.test(String(value))) throw failure("INVALID_RESPONSE");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw failure("INVALID_RESPONSE");
  return number;
}
function parseResponse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw failure("INVALID_RESPONSE");
  const clean = text.replace(/^\uFEFF/, "").trim();
  let code, body;
  if (clean.startsWith("<")) {
    if (/<!DOCTYPE|<!ENTITY/i.test(clean)) throw failure("INVALID_RESPONSE");
    const gateway = xmlTag(clean, "cmmMsgHeader");
    if (gateway !== null) throw providerError(xmlLeaf(gateway, "returnReasonCode"));
    const response = xmlTag(clean, "response");
    const header = response === null ? null : xmlTag(response, "header");
    if (header === null) throw failure("INVALID_RESPONSE");
    code = xmlLeaf(header, "resultCode");
    if (!/^0{1,4}$/.test(String(code))) throw providerError(code);
    const content = xmlTag(response, "body");
    if (content === null) throw failure("INVALID_RESPONSE");
    const items = [...(xmlTag(content, "items") || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/g)].map(match => Object.fromEntries(["baseYmd", "areaCd", "areaNm", "signguCd", "signguNm", "tAtsNm", "cnctrRate"].map(field => [field, xmlLeaf(match[1], field)])));
    body = { items: { item: items }, totalCount: xmlLeaf(content, "totalCount"), numOfRows: xmlLeaf(content, "numOfRows"), pageNo: xmlLeaf(content, "pageNo") };
  } else {
    let payload;
    try { payload = JSON.parse(clean); } catch { throw failure("INVALID_RESPONSE"); }
    const response = payload?.response || payload;
    code = response?.header?.resultCode;
    if (code === undefined || code === null) throw failure("INVALID_RESPONSE");
    if (!/^0{1,4}$/.test(String(code))) throw providerError(code);
    body = response.body;
  }
  if (!body || typeof body !== "object") throw failure("INVALID_RESPONSE");
  const value = body.items?.item;
  const items = value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]);
  return { items, totalCount: integer(body.totalCount, 0), pageNo: integer(body.pageNo, 1), numOfRows: integer(body.numOfRows, 1) };
}
function normalizeRows(rows, region, queryDate) {
  const groups = new Map();
  for (const row of rows) {
    if (!row || String(row.areaCd) !== region.areaCd || String(row.signguCd) !== region.signguCd) throw failure("INVALID_RESPONSE");
    const name = typeof row.tAtsNm === "string" ? row.tAtsNm.trim() : "";
    if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw failure("INVALID_RESPONSE");
    const date = dateString(row.baseYmd);
    if (typeof row.cnctrRate !== "number" && (typeof row.cnctrRate !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(row.cnctrRate.trim()))) throw failure("INVALID_RESPONSE");
    const value = Number(row.cnctrRate);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw failure("INVALID_RESPONSE");
    if (!groups.has(name)) groups.set(name, new Map());
    const days = groups.get(name);
    if (days.has(date)) throw failure("INVALID_RESPONSE");
    days.set(date, { date, value });
  }
  return [...groups].map(([name, days]) => {
    const series = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (series.length !== 30 || series.some((point, index) => index > 0 && dayNumber(point.date) - dayNumber(series[index - 1].date) !== 1)) throw failure("INVALID_RESPONSE");
    const startDate = series[0].date;
    const endDate = series.at(-1).date;
    // The provider may start its daily window yesterday. Preserve that date and
    // disclose the lag; never relabel the observations as today's next 30 days.
    if (dayNumber(startDate) > dayNumber(queryDate) + 1 || dayNumber(endDate) > dayNumber(queryDate) + 30) throw failure("INVALID_RESPONSE");
    const id = Buffer.from(JSON.stringify([region.areaCd, region.signguCd, name]), "utf8").toString("base64url");
    return { id, name, ...region, series, startDate, endDate, complete: true };
  }).sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function createTourismForecastService({ dataDir, readServiceKey, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 12000 } = {}) {
  if (!dataDir || typeof readServiceKey !== "function" || typeof fetchImpl !== "function") throw new TypeError("관광지 예측 저장 경로와 인증키 조회 함수가 필요합니다.");
  const directory = path.resolve(dataDir);
  const attempts = new Map();
  const inFlight = new Map();
  const clock = () => Number(now());
  const today = () => kstDate(clock());
  const identity = region => `${region.areaCd}-${region.signguCd}`;
  const cachePath = region => path.join(directory, `tourism-forecast-${identity(region)}.json`);
  async function key() { try { return serviceKey(await readServiceKey()); } catch { return ""; } }
  async function readCache(region) {
    try {
      const value = JSON.parse(await fs.readFile(cachePath(region), "utf8"));
      if (value.version !== 1 || value.region?.areaCd !== region.areaCd || value.region?.signguCd !== region.signguCd || !Array.isArray(value.destinations) || !Number.isFinite(Date.parse(value.collectedAt))) throw failure("CACHE_READ_ERROR");
      const queryDate = dateString(value.queryDate);
      const collectedDay = kstDate(Date.parse(value.collectedAt));
      if (dayNumber(collectedDay) < dayNumber(queryDate) || dayNumber(collectedDay) > dayNumber(queryDate) + 1) throw failure("CACHE_READ_ERROR");
      const rows = value.destinations.flatMap(destination => (destination.series || []).map(point => ({ areaCd: destination.areaCd, signguCd: destination.signguCd, tAtsNm: destination.name, baseYmd: point.date, cnctrRate: point.value })));
      const destinations = normalizeRows(rows, region, queryDate);
      if (value.destinations.length !== destinations.length || (!destinations.length && value.noData !== true)) throw failure("CACHE_READ_ERROR");
      return { version: 1, region, collectedAt: value.collectedAt, queryDate, destinations, noData: destinations.length === 0 };
    } catch (error) {
      return { region, collectedAt: null, queryDate: null, destinations: [], readError: error.code === "ENOENT" ? null : publicError(failure("CACHE_READ_ERROR")) };
    }
  }
  async function saveCache(cache) {
    const temporary = `${cachePath(cache.region)}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, cachePath(cache.region));
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw failure("CACHE_WRITE_ERROR");
    }
  }
  async function requestPage(region, value, pageNo) {
    const url = new URL(ENDPOINT);
    for (const [name, entry] of Object.entries({ serviceKey: value, pageNo, numOfRows: 1000, MobileOS: "ETC", MobileApp: "STAYDATALAB", areaCd: region.areaCd, signguCd: region.signguCd, _type: "json" })) url.searchParams.set(name, String(entry));
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url.toString(), { signal: controller.signal, redirect: "error", headers: { Accept: "application/json, application/xml;q=0.9" } });
          if (response.status === 401 || response.status === 403) throw failure("AUTH_ERROR");
          if (response.status === 429) throw failure("QUOTA_EXCEEDED");
          if (!response.ok) throw failure("SERVICE_UNAVAILABLE");
          const parsed = parseResponse(await response.text());
          if (parsed.pageNo !== pageNo || parsed.items.length > parsed.numOfRows || parsed.items.length > parsed.totalCount) throw failure("INVALID_RESPONSE");
          return parsed;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("TIMEOUT")); }, Math.max(1, timeoutMs)); })
      ]);
    } catch (error) { throw failure(publicError(error).code); }
    finally { clearTimeout(timer); }
  }
  async function collect(region, value, queryDate) {
    const rows = [];
    let total = null;
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      let page;
      try { page = await requestPage(region, value, pageNo); }
      catch (error) {
        if (error.code === "NO_DATA" && pageNo === 1) return [];
        if (error.code === "NO_DATA") throw failure("INVALID_RESPONSE");
        throw error;
      }
      if (total === null) total = page.totalCount;
      if (total !== page.totalCount || total > 20000 || (page.items.length === 0 && rows.length < total)) throw failure("INVALID_RESPONSE");
      rows.push(...page.items);
      if (rows.length > total) throw failure("INVALID_RESPONSE");
      if (rows.length === total) return normalizeRows(rows, region, queryDate);
    }
    throw failure("INVALID_RESPONSE");
  }
  function resultFor(cache, configured, networkAttempted = false) {
    const attempt = attempts.get(identity(cache.region));
    const error = attempt?.error || (!cache.collectedAt ? (configured ? cache.readError || publicError(failure("NOT_COLLECTED")) : publicError(failure("MISSING_KEY"))) : null);
    const currentDate = today();
    const destinations = cache.destinations.map(destination => ({ ...destination, series: destination.series.map(point => ({ ...point })), upcomingDayCount: destination.series.filter(point => point.date >= currentDate).length, providerLagDays: Math.max(0, dayNumber(currentDate) - dayNumber(destination.startDate)) }));
    const stale = Boolean(cache.collectedAt && (cache.queryDate !== currentDate || error || destinations.some(destination => destination.upcomingDayCount === 0)));
    const status = cache.collectedAt
      ? (error || stale ? "partial" : (cache.noData ? "no_data" : "ready"))
      : (configured ? "error" : "missing_key");
    return { status, region: { ...cache.region }, source: { ...SOURCE }, collectedAt: cache.collectedAt, queryDate: cache.queryDate, stale, networkAttempted, destinations, errors: error ? [error] : (cache.noData ? [publicError(failure("NO_DATA"))] : []) };
  }
  async function loadRegion(region, refresh) {
    let cache = await readCache(region);
    const value = await key();
    const attempt = attempts.get(identity(region));
    if (!refresh && cache.queryDate === today() && !attempt?.error) return resultFor(cache, Boolean(value));
    if (!refresh && attempt?.error && clock() - attempt.at < COOLDOWN_MS) return resultFor(cache, Boolean(value));
    if (!value) return resultFor(cache, false);
    const queryDate = today();
    try {
      const destinations = await collect(region, value, queryDate);
      if (!destinations.length && cache.destinations.length) throw failure("NO_DATA");
      const prior = new Map(cache.destinations.map(destination => [destination.id, destination]));
      if (destinations.some(destination => prior.has(destination.id) && destination.startDate < prior.get(destination.id).startDate)) throw failure("STALE_RESPONSE");
      const next = { version: 1, region, collectedAt: new Date(clock()).toISOString(), queryDate, destinations, noData: destinations.length === 0 };
      // Keep the actual receive time. Freshness uses the request's queryDate,
      // so a midnight-spanning request is not reused for an extra KST day.
      await saveCache(next);
      cache = next;
      attempts.set(identity(region), { at: clock(), error: null });
    } catch (error) { attempts.set(identity(region), { at: clock(), error: publicError(error) }); }
    return resultFor(cache, true, true);
  }
  async function getRegionForecast(input, { refresh = false } = {}) {
    const region = validateRegion(input);
    const id = identity(region);
    if (inFlight.has(id)) return inFlight.get(id);
    const pending = loadRegion(region, refresh === true);
    inFlight.set(id, pending);
    try { return await pending; } finally { inFlight.delete(id); }
  }
  async function status() {
    const configured = Boolean(await key());
    const files = await fs.readdir(directory).catch(() => []);
    const cachedRegions = [];
    for (const filename of files) {
      const match = /^tourism-forecast-(\d{2})-(\d{5})\.json$/.exec(filename);
      if (!match) continue;
      const region = REGION_MAP.get(`${match[1]}:${match[2]}`);
      if (!region) continue;
      const cache = await readCache(region);
      if (!cache.collectedAt) continue;
      const result = resultFor(cache, configured);
      cachedRegions.push({ ...region, collectedAt: cache.collectedAt, queryDate: cache.queryDate, destinationCount: cache.destinations.length, stale: result.stale, status: result.status });
    }
    return { configured, source: { ...SOURCE }, regions: REGIONS.map(region => ({ ...region })), cachedRegions: cachedRegions.sort((a, b) => a.areaCd.localeCompare(b.areaCd) || a.signguCd.localeCompare(b.signguCd)), retryCooldownSeconds: 300 };
  }
  return { status, getRegionForecast };
}

module.exports = { createTourismForecastService, validateRegion, parseResponse, normalizeRows, SOURCE };
