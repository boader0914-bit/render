"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// Verified against KOSIS statisticsData.do getMeta/ITM. Each table has its own
// region classification: population and industry codes are NOT interchangeable.
const DEFINITIONS = Object.freeze([
  { key: "population", label: "주민등록 인구", tableId: "DT_1B040A3", orgId: "101", periodType: "M", regionObject: "A", metrics: [
    { key: "population", label: "총인구", id: "T20", unit: "명" },
    { key: "male", label: "남성 인구", id: "T21", unit: "명" },
    { key: "female", label: "여성 인구", id: "T22", unit: "명" }
  ] },
  { key: "households", label: "주민등록 세대 수", tableId: "DT_1B040B3", orgId: "101", periodType: "M", regionObject: "A", metrics: [
    { key: "registered_households", label: "주민등록 세대 수 (가구 수와 다름)", id: "T1", unit: "세대" }
  ] },
  { key: "age_population", label: "주민등록 인구 연령 분포", tableId: "DT_1B04005N", orgId: "101", periodType: "M", regionObject: "A", breakdownObject: "B", metrics: [
    { key: "population", label: "인구", id: "T2", unit: "명" }
  ], breakdowns: [
    { id: "0", key: "all_ages", label: "전체 연령", metadataName: "계" },
    ...Array.from({ length: 20 }, (_, index) => ({ id: String((index + 1) * 5), key: `age_${index * 5}_${index * 5 + 4}`, label: `${index * 5}~${index * 5 + 4}세`, metadataName: `${index * 5} - ${index * 5 + 4}세` })),
    { id: "105", key: "age_100_plus", label: "100세 이상", metadataName: "100+" }
  ] },
  { key: "establishments", label: "사업체 수", tableId: "DT_1YL20832", orgId: "101", periodType: "Y", regionObject: "SGG", metrics: [
    { key: "establishments", label: "사업체 수", id: "T10", unit: "개" }
  ] },
  { key: "employment", label: "종사자 수", tableId: "DT_1YL15014", orgId: "101", periodType: "Y", regionObject: "SGG", metrics: [
    { key: "employees", label: "총종사자 수", id: "T001", unit: "명" },
    { key: "male", label: "남성 종사자 수", id: "T002", unit: "명" },
    { key: "female", label: "여성 종사자 수", id: "T003", unit: "명" }
  ] },
  { key: "manufacturing_establishments", label: "제조업 사업체 수", tableId: "DT_1YL5702", orgId: "101", periodType: "Y", regionObject: "SGG", metrics: [
    { key: "manufacturing_establishments", label: "제조업 사업체 수", id: "T10", unit: "개" }
  ] },
  { key: "manufacturing_employment", label: "제조업 종사자 수", tableId: "DT_1YL5802", orgId: "101", periodType: "Y", regionObject: "SGG", metrics: [
    { key: "manufacturing_employees", label: "제조업 종사자 수", id: "T10", unit: "명" }
  ] }
].map(definition => Object.freeze({ ...definition, metrics: Object.freeze(definition.metrics.map(metric => Object.freeze(metric))), ...(definition.breakdowns ? { breakdowns: Object.freeze(definition.breakdowns.map(item => Object.freeze(item))) } : {}) })));
const METADATA_ENDPOINT = "https://kosis.kr/openapi/statisticsData.do";
const DATA_ENDPOINT = "https://kosis.kr/openapi/Param/statisticsParameterData.do";
const MAX_BODY = 2 * 1024 * 1024;
const MESSAGES = Object.freeze({
  MISSING_KEY: "Render 환경변수 KOSIS_API_KEY를 설정해 주세요.",
  INVALID_REGION: "조회할 행정지역을 확인해 주세요.",
  AMBIGUOUS_REGION: "지역을 하나로 확인할 수 없어 조회하지 않았습니다.",
  MAPPING_MISSING: "이 통계표의 공식 지역 분류와 선택 지역을 연결하지 못했습니다.",
  INVALID_RESPONSE: "KOSIS 응답의 항목·단위·지역 구성을 확인하지 못했습니다.",
  PERIOD_MISMATCH: "KOSIS 응답의 기준 기간이 일치하지 않습니다.",
  AUTH_ERROR: "KOSIS 인증키와 Open API 이용 승인을 확인해 주세요.",
  QUOTA_EXCEEDED: "KOSIS 요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.",
  TIMEOUT: "KOSIS 응답 대기시간을 초과했습니다.",
  NETWORK_ERROR: "KOSIS에서 정상 응답을 받지 못했습니다.",
  CACHE_READ_ERROR: "저장된 KOSIS 자료를 읽지 못했습니다.",
  CACHE_WRITE_ERROR: "KOSIS 자료 저장에 실패하여 이전 자료를 유지합니다.",
  COOLDOWN: "최근 갱신을 수행했습니다. 잠시 후 다시 갱신해 주세요.",
  REFRESH_INCOMPLETE: "이전 갱신의 종료를 확인하지 못했습니다. 저장 자료를 유지합니다.",
  NO_DATA: "KOSIS에 해당 지역·항목의 조회 결과가 없습니다.",
  MISSING_VALUES: "KOSIS 응답에 비공개 또는 누락된 값이 있어 이전 정상 자료를 유지합니다."
});
function problem(code) { const error = new Error(MESSAGES[code] || MESSAGES.NETWORK_ERROR); error.code = Object.hasOwn(MESSAGES, code) ? code : "NETWORK_ERROR"; return error; }
function publicError(error) { const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : "NETWORK_ERROR"; return { code, message: MESSAGES[code] }; }
function sourceUrl(definition) { return `https://kosis.kr/statHtml/statHtml.do?orgId=${definition.orgId}&tblId=${definition.tableId}`; }
function publicDefinition(definition) { return { key: definition.key, label: definition.label, tableId: definition.tableId, orgId: definition.orgId, periodType: definition.periodType, sourceUrl: sourceUrl(definition) }; }
function normalizedName(value) { return typeof value === "string" ? value.replace(/\s/g, "") : ""; }
function validCode(value) { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(value); }
function dateStamp(value) {
  const raw = String(value ?? "").trim();
  const match = /^(\d{4})[-.]?(\d{2})[-.]?(\d{2})$/.exec(raw);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}
function parseValue(value) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (["", "-", ".", ".."].includes(raw)) return { value: null, status: "missing" };
  if (["...", "*", "**", "***", "X", "x"].includes(raw)) return { value: null, status: "suppressed" };
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) throw problem("INVALID_RESPONSE");
  const number = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(number)) throw problem("INVALID_RESPONSE");
  return { value: number, status: "observed" };
}
function mapRegion(metadata, definition, region) {
  if (!Array.isArray(metadata) || !metadata.length) throw problem("INVALID_RESPONSE");
  const dimensions = metadata.filter(row => String(row.OBJ_ID) === definition.regionObject && String(row.OBJ_ID_SN) === "1");
  const items = new Set(metadata.filter(row => String(row.OBJ_ID).toUpperCase() === "ITEM").map(row => String(row.ITM_ID)));
  if (definition.metrics.some(metric => !items.has(metric.id))) throw problem("INVALID_RESPONSE");
  if (definition.breakdowns) {
    const classes = metadata.filter(row => String(row.OBJ_ID) === definition.breakdownObject && String(row.OBJ_ID_SN) === "2");
    if (definition.breakdowns.some(item => classes.filter(row => String(row.ITM_ID) === item.id && normalizedName(row.ITM_NM) === normalizedName(item.metadataName)).length !== 1)) throw problem("INVALID_RESPONSE");
  }
  const names = new Set([region.name, region.fullName].map(normalizedName).filter(Boolean));
  const provinceNames = new Set([region.provinceName, region.sidoFull].map(normalizedName).filter(Boolean));
  const matches = dimensions.filter(row => names.has(normalizedName(row.ITM_NM))).filter(row => {
    if (region.level === "broad") return provinceNames.has(normalizedName(row.ITM_NM)) || normalizedName(row.ITM_NM) === normalizedName(region.name);
    const visited = new Set([String(row.ITM_ID)]);
    let parentId = String(row.UP_ITM_ID ?? "");
    // Some current tables retain an intermediate former province/city. Follow
    // only the provider's explicit hierarchy; never infer hierarchy from codes.
    for (let depth = 0; depth < 8; depth++) {
      if (!parentId || visited.has(parentId)) return false;
      visited.add(parentId);
      const parents = dimensions.filter(parent => String(parent.ITM_ID) === parentId);
      if (parents.length !== 1) return false;
      if (provinceNames.has(normalizedName(parents[0].ITM_NM))) return true;
      parentId = String(parents[0].UP_ITM_ID ?? "");
    }
    return false;
  });
  if (matches.length !== 1 || !validCode(String(matches[0]?.ITM_ID ?? ""))) throw problem("MAPPING_MISSING");
  return { code: String(matches[0].ITM_ID), basis: "kosis-table-metadata-name-and-ancestry", tableId: definition.tableId };
}
function normalizeData(payload, definition, mapping, retrievedAt) {
  if (!Array.isArray(payload) || !payload.length || payload.length > 100) throw problem("INVALID_RESPONSE");
  const found = new Map();
  const periods = new Set();
  const updated = [];
  for (const item of payload) {
    const metric = definition.metrics.find(candidate => candidate.id === String(item.ITM_ID));
    const responsePeriod = String(item.PRD_SE) === "A" ? "Y" : String(item.PRD_SE);
    if (!metric || String(item.TBL_ID) !== definition.tableId || String(item.C1) !== mapping.code || responsePeriod !== definition.periodType || String(item.UNIT_NM).trim() !== metric.unit) throw problem("INVALID_RESPONSE");
    if (item.ORG_ID !== undefined && String(item.ORG_ID) !== definition.orgId) throw problem("INVALID_RESPONSE");
    const breakdown = definition.breakdowns?.find(candidate => candidate.id === String(item.C2));
    if (definition.breakdowns ? !breakdown : item.C2 !== undefined && item.C2 !== null && String(item.C2).trim() !== "") throw problem("INVALID_RESPONSE");
    for (let index = 3; index <= 8; index++) if (item[`C${index}`] !== undefined && item[`C${index}`] !== null && String(item[`C${index}`]).trim() !== "") throw problem("INVALID_RESPONSE");
    const period = String(item.PRD_DE);
    if (!(definition.periodType === "M" ? /^\d{4}(0[1-9]|1[0-2])$/ : /^\d{4}$/).test(period)) throw problem("PERIOD_MISMATCH");
    const reference = definition.periodType === "M" ? `${period.slice(0, 4)}-${period.slice(4)}-01` : `${period}-01-01`;
    if (reference > retrievedAt.slice(0, 10) || Number(period.slice(0, 4)) < 1900) throw problem("PERIOD_MISMATCH");
    periods.add(period);
    const identity = `${metric.id}:${breakdown?.id || ""}`;
    if (found.has(identity)) throw problem("INVALID_RESPONSE");
    const value = parseValue(item.DT);
    found.set(identity, { key: breakdown?.key || metric.key, label: breakdown?.label || metric.label, ...value, unit: metric.unit, period, itemId: metric.id, ...(breakdown ? { classId: breakdown.id } : {}) });
    const changed = dateStamp(item.LST_CHN_DE);
    if (changed) updated.push(changed);
  }
  if (periods.size !== 1) throw problem("PERIOD_MISMATCH");
  const period = [...periods][0];
  const rows = definition.metrics.flatMap(metric => (definition.breakdowns || [null]).map(breakdown => found.get(`${metric.id}:${breakdown?.id || ""}`) || { key: breakdown?.key || metric.key, label: breakdown?.label || metric.label, value: null, unit: metric.unit, period, itemId: metric.id, ...(breakdown ? { classId: breakdown.id } : {}), status: "missing" }));
  return { ...publicDefinition(definition), status: rows.every(row => row.status === "observed") ? "ready" : "partial", period, updatedAt: retrievedAt, retrievedAt, sourceUpdatedAt: updated.length ? updated.sort().at(-1) : null, mapping, rows };
}

function createKosisService({ dataDir, readApiKey, regionMasterFile, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 12000, cooldownMs = 300000, dailyBudget = 100, minIntervalMs = 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!dataDir || !regionMasterFile || typeof readApiKey !== "function" || typeof fetchImpl !== "function") throw new TypeError("KOSIS 저장 경로, 지역 원장과 인증키 조회 함수가 필요합니다.");
  const directory = path.resolve(dataDir);
  const attempts = new Map();
  const flights = new Map();
  let chain = Promise.resolve();
  let lastStart = -Infinity;
  let lastError = null;
  const at = () => Number(now());
  const iso = () => new Date(at()).toISOString();
  const budgetLimit = Number.isSafeInteger(dailyBudget) && dailyBudget > 0 ? Math.min(dailyBudget, 1000) : 100;
  const interval = Math.max(1000, Number(minIntervalMs) || 1000);
  const cacheFile = region => path.join(directory, `${crypto.createHash("sha256").update(region.regionId).digest("hex").slice(0, 24)}.json`);
  const attemptFile = region => cacheFile(region).replace(/\.json$/, "-attempt.json");
  async function key() { try { const value = await readApiKey(); return typeof value === "string" && value.trim().length <= 512 && !/[\r\n]/.test(value) ? value.trim() : ""; } catch { return ""; } }
  async function regionFor(regionKey) {
    if (typeof regionKey !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(regionKey)) throw problem("INVALID_REGION");
    let master;
    try { master = JSON.parse(await fs.readFile(regionMasterFile, "utf8")); } catch { throw problem("INVALID_REGION"); }
    if (!Array.isArray(master.units)) throw problem("INVALID_REGION");
    const matches = master.units.filter(unit => unit.active === true && unit.selectable !== false && [unit.regionKey, unit.regionId, unit.locationCardKey, unit.providerMappings?.kto?.regionKey].includes(regionKey));
    if (matches.length > 1) throw problem("AMBIGUOUS_REGION");
    const unit = matches[0];
    if (!unit || !["local", "broad"].includes(unit.level) || typeof unit.regionId !== "string") throw problem("INVALID_REGION");
    const province = master.units.find(candidate => candidate.regionId === unit.provinceRegionId && candidate.active === true);
    return { regionKey, regionId: unit.regionId, name: unit.name, fullName: unit.fullName || unit.name, level: unit.level, sidoFull: unit.sidoFull || null, provinceName: province?.name || unit.sidoFull || null };
  }
  async function readCache(region) {
    try {
      const cache = JSON.parse(await fs.readFile(cacheFile(region), "utf8"));
      if (cache.version !== 1 || cache.regionId !== region.regionId || !cache.datasets || typeof cache.datasets !== "object") throw problem("CACHE_READ_ERROR");
      const datasets = {};
      for (const definition of DEFINITIONS) {
        const item = cache.datasets[definition.key];
        if (!item) continue;
        if (!["ready", "partial"].includes(item.status) || item.tableId !== definition.tableId || !Number.isFinite(Date.parse(item.retrievedAt)) || !validCode(item.mapping?.code) || item.mapping?.tableId !== definition.tableId || !Array.isArray(item.rows)) throw problem("CACHE_READ_ERROR");
        for (const row of item.rows) {
          if (!["observed", "missing", "suppressed"].includes(row.status) || (row.status === "observed" ? !Number.isSafeInteger(row.value) || row.value < 0 : row.value !== null)) throw problem("CACHE_READ_ERROR");
        }
        // Rebuild cached values using the same strict parser as upstream input.
        const normalized = normalizeData(item.rows.map(row => ({ TBL_ID: item.tableId, ITM_ID: row.itemId, C1: item.mapping.code, ...(row.classId !== undefined ? { C2: row.classId } : {}), PRD_SE: item.periodType, PRD_DE: row.period, UNIT_NM: row.unit, DT: row.status === "suppressed" ? "..." : row.value, LST_CHN_DE: item.sourceUpdatedAt })), definition, item.mapping, item.retrievedAt);
        if (normalized.status !== item.status) throw problem("CACHE_READ_ERROR");
        datasets[definition.key] = normalized;
      }
      return { version: 1, regionId: region.regionId, datasets };
    } catch (error) { return { version: 1, regionId: region.regionId, datasets: {}, readError: error.code === "ENOENT" ? null : publicError(problem("CACHE_READ_ERROR")) }; }
  }
  async function readAttempt(region) {
    try {
      const raw = JSON.parse(await fs.readFile(attemptFile(region), "utf8"));
      if (raw.version !== 1 || raw.regionId !== region.regionId || !Number.isFinite(Date.parse(raw.startedAt)) || (raw.finishedAt !== null && !Number.isFinite(Date.parse(raw.finishedAt)))) throw problem("CACHE_READ_ERROR");
      const outcomes = {};
      for (const definition of DEFINITIONS) {
        const outcome = raw.outcomes?.[definition.key];
        if (!outcome) continue;
        if (!["ready", "stale", "partial", "mapping_missing", "error"].includes(outcome.status)) throw problem("CACHE_READ_ERROR");
        outcomes[definition.key] = { status: outcome.status, error: outcome.error ? publicError(outcome.error) : null };
      }
      return { version: 1, regionId: region.regionId, startedAt: raw.startedAt, finishedAt: raw.finishedAt, outcomes };
    } catch (error) { return error.code === "ENOENT" ? null : { readError: publicError(problem("CACHE_READ_ERROR")) }; }
  }
  async function atomic(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, file); }
    catch { await fs.unlink(temporary).catch(() => {}); throw problem("CACHE_WRITE_ERROR"); }
  }
  async function saveCache(region, cache) {
    const value = { version: 1, regionId: region.regionId, datasets: cache.datasets };
    // An immutable history snapshot precedes replacement of the current pointer.
    const history = path.join(directory, "history", `${path.basename(cacheFile(region), ".json")}-${at()}-${crypto.randomUUID()}.json`);
    await atomic(history, value);
    await atomic(cacheFile(region), value);
  }
  async function takeBudget() {
    const day = new Date(at() + 9 * 3600000).toISOString().slice(0, 10);
    const file = path.join(directory, "request-budget.json");
    let record = { day, count: 0 };
    try { const old = JSON.parse(await fs.readFile(file, "utf8")); if (old.day === day && Number.isSafeInteger(old.count) && old.count >= 0) record = old; }
    catch (error) { if (error.code !== "ENOENT") throw problem("CACHE_READ_ERROR"); }
    if (record.count >= budgetLimit) throw problem("QUOTA_EXCEEDED");
    await atomic(file, { day, count: record.count + 1 });
  }
  async function readBody(response) {
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_BODY) throw problem("INVALID_RESPONSE");
    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_BODY) throw problem("INVALID_RESPONSE");
      return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try { while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > MAX_BODY) throw problem("INVALID_RESPONSE"); chunks.push(Buffer.from(result.value)); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function request(parameters, apiKey, onAttempt) {
    const task = chain.catch(() => {}).then(async () => {
      const wait = Math.max(0, lastStart + interval - at());
      if (wait) await sleep(wait);
      await takeBudget();
      const url = new URL(parameters.method === "getMeta" ? METADATA_ENDPOINT : DATA_ENDPOINT);
      for (const [name, value] of Object.entries({ ...parameters, apiKey, format: "json", jsonVD: "Y" })) url.searchParams.set(name, String(value));
      const controller = new AbortController();
      let timer;
      lastStart = at();
      onAttempt();
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(url.toString(), { redirect: "error", signal: controller.signal, headers: { Accept: "application/json" } });
            if ([401, 403].includes(response.status)) throw problem("AUTH_ERROR");
            if (response.status === 429) throw problem("QUOTA_EXCEEDED");
            if (!response.ok) throw problem("NETWORK_ERROR");
            let payload;
            try { payload = JSON.parse(await readBody(response)); } catch (error) { throw Object.hasOwn(MESSAGES, error?.code) ? error : problem("INVALID_RESPONSE"); }
            if (!Array.isArray(payload)) {
              const code = String(payload?.err ?? payload?.errCd ?? "");
              if (["10", "11"].includes(code)) throw problem("AUTH_ERROR");
              if (["40", "41", "42"].includes(code)) throw problem("QUOTA_EXCEEDED");
              if (code === "30") throw problem("NO_DATA");
              if (code === "50") throw problem("NETWORK_ERROR");
              throw problem("INVALID_RESPONSE");
            }
            return payload;
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem("TIMEOUT")); }, Math.min(30000, Math.max(1, Number(timeoutMs) || 12000))); })
        ]);
      } catch (error) { throw problem(publicError(error).code); }
      finally { clearTimeout(timer); }
    });
    chain = task.catch(() => {});
    return task;
  }
  function emptyDataset(definition) { return { ...publicDefinition(definition), status: "not_collected", period: null, updatedAt: null, retrievedAt: null, sourceUpdatedAt: null, rows: [] }; }
  function present(region, cache, configured, overrides = {}) {
    const datasets = DEFINITIONS.map(definition => cache.datasets[definition.key] || emptyDataset(definition));
    const count = datasets.filter(dataset => dataset.status === "ready").length;
    const hasSnapshot = datasets.some(dataset => ["ready", "partial"].includes(dataset.status));
    return { configured, status: count === DEFINITIONS.length ? "ready" : hasSnapshot ? "partial" : configured ? "not_collected" : "needs_key", region, datasets, networkAttempted: false, error: cache.readError || null, ...overrides };
  }
  function withAttempt(result, attempt) {
    if (!attempt) return result;
    if (attempt.readError) return { ...result, status: "error", error: attempt.readError };
    const outcomes = attempt.outcomes;
    const interrupted = !attempt.finishedAt && !flights.has(result.region.regionId);
    const datasets = result.datasets.map(dataset => {
      const outcome = outcomes[dataset.key];
      const error = interrupted ? publicError(problem("REFRESH_INCOMPLETE")) : outcome?.error;
      if (!error || (dataset.retrievedAt && dataset.retrievedAt > (attempt.finishedAt || attempt.startedAt))) return dataset;
      const currentPartial = dataset.status === "partial" && outcome?.status === "partial" && dataset.retrievedAt >= attempt.startedAt;
      return { ...dataset, status: dataset.rows.length ? currentPartial ? "partial" : "stale" : outcome?.status || "error", error };
    });
    const error = datasets.find(dataset => dataset.error)?.error || null;
    const status = error ? datasets.some(dataset => dataset.rows.length) ? "partial" : datasets.every(dataset => dataset.status === "mapping_missing") ? "mapping_missing" : "error" : result.status;
    return { ...result, datasets, status, error: error || result.error, lastAttemptAt: attempt.startedAt, lastAttemptFinishedAt: attempt.finishedAt };
  }
  async function getRegion(regionKey) {
    const configured = Boolean(await key());
    try { const region = await regionFor(regionKey); return withAttempt(present(region, await readCache(region), configured), await readAttempt(region)); }
    catch (error) { return { configured, status: "mapping_missing", region: { regionKey }, datasets: DEFINITIONS.map(emptyDataset), networkAttempted: false, error: publicError(error) }; }
  }
  async function refreshRegion(regionKey) {
    const apiKey = await key();
    let region;
    try { region = await regionFor(regionKey); }
    catch (error) { return { ...(await getRegion(regionKey)), error: publicError(error) }; }
    if (flights.has(region.regionId)) {
      const result = await flights.get(region.regionId);
      return { ...result, region };
    }
    const run = (async () => {
      const cache = await readCache(region);
      if (!apiKey) return present(region, cache, false, { status: "needs_key", error: publicError(problem("MISSING_KEY")) });
      const previousAttempt = await readAttempt(region);
      if (previousAttempt?.readError) return present(region, cache, true, { status: "error", error: previousAttempt.readError });
      const previousStart = Math.max(attempts.get(region.regionId) || -Infinity, previousAttempt?.startedAt ? Date.parse(previousAttempt.startedAt) : -Infinity);
      if (at() - previousStart < Math.max(0, cooldownMs)) return { ...withAttempt(present(region, cache, true), previousAttempt), status: "cooldown", error: publicError(problem("COOLDOWN")) };
      attempts.set(region.regionId, at());
      const attempt = { version: 1, regionId: region.regionId, startedAt: iso(), finishedAt: null, outcomes: {} };
      try { await atomic(attemptFile(region), attempt); }
      catch (error) { return present(region, cache, true, { status: "error", error: publicError(error) }); }
      const staged = { version: 1, regionId: region.regionId, datasets: { ...cache.datasets } };
      const outcomes = [];
      let networkAttempted = false;
      let changed = false;
      let stopError = null;
      for (const definition of DEFINITIONS) {
        try {
          if (stopError) throw stopError;
          const meta = await request({ method: "getMeta", type: "ITM", orgId: definition.orgId, tblId: definition.tableId }, apiKey, () => { networkAttempted = true; });
          const mapping = mapRegion(meta, definition, region);
          const data = await request({ method: "getList", orgId: definition.orgId, tblId: definition.tableId, itmId: definition.metrics.map(metric => metric.id).join("+") + "+", objL1: mapping.code, ...(definition.breakdowns ? { objL2: definition.breakdowns.map(item => item.id).join("+") + "+" } : {}), prdSe: definition.periodType, newEstPrdCnt: 1, smblChk: "Y" }, apiKey, () => { networkAttempted = true; });
          const dataset = normalizeData(data, definition, mapping, iso());
          if (dataset.status !== "ready") {
            const error = publicError(problem("MISSING_VALUES"));
            // Keep a first partial observation for audit and display, including
            // null/suppressed values. Never replace an existing snapshot with
            // a partial response or combine values from different periods.
            if (!cache.datasets[definition.key]) {
              staged.datasets[definition.key] = dataset;
              changed = true;
            }
            outcomes.push(cache.datasets[definition.key] ? { ...cache.datasets[definition.key], status: "stale", error } : { ...dataset, error });
            continue;
          }
          staged.datasets[definition.key] = dataset;
          outcomes.push(dataset);
          changed = true;
        } catch (error) {
          const safe = publicError(error);
          if (["AUTH_ERROR", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR"].includes(safe.code)) stopError = problem(safe.code);
          outcomes.push({ ...(cache.datasets[definition.key] || emptyDataset(definition)), status: cache.datasets[definition.key] ? "stale" : safe.code === "MAPPING_MISSING" ? "mapping_missing" : "error", error: safe });
        }
      }
      if (changed) {
        try { await saveCache(region, staged); }
        catch (error) {
          lastError = publicError(error);
          attempt.finishedAt = iso();
          attempt.outcomes = Object.fromEntries(DEFINITIONS.map(definition => [definition.key, { status: "error", error: lastError }]));
          await atomic(attemptFile(region), attempt).catch(() => {});
          return present(region, cache, true, { status: "error", networkAttempted, error: lastError });
        }
      }
      attempt.finishedAt = iso();
      attempt.outcomes = Object.fromEntries(outcomes.map(dataset => [dataset.key, { status: dataset.status, error: dataset.error || null }]));
      try { await atomic(attemptFile(region), attempt); }
      catch (error) { lastError = publicError(error); return present(region, staged, true, { status: "error", networkAttempted, error: lastError }); }
      const errors = outcomes.filter(dataset => dataset.error).map(dataset => dataset.error);
      lastError = errors[0] || null;
      const allReady = outcomes.every(dataset => dataset.status === "ready");
      return present(region, staged, true, { datasets: outcomes, networkAttempted, lastAttemptAt: attempt.startedAt, lastAttemptFinishedAt: attempt.finishedAt, status: allReady ? "ready" : outcomes.every(dataset => dataset.status === "mapping_missing") ? "mapping_missing" : outcomes.some(dataset => ["ready", "stale", "partial"].includes(dataset.status)) ? "partial" : "error", error: errors[0] || null });
    })();
    flights.set(region.regionId, run);
    try { return await run; } finally { flights.delete(region.regionId); }
  }
  async function status() {
    const configured = Boolean(await key());
    let cachedRegionCount = 0;
    let completeRegionCount = 0;
    let lastSuccessAt = null;
    let readError = null;
    let files = [];
    try { files = await fs.readdir(directory); } catch (error) { if (error.code !== "ENOENT") readError = publicError(problem("CACHE_READ_ERROR")); }
    const stems = [...new Set(files.filter(name => /^[a-f0-9]{24}(?:-attempt)?\.json$/.test(name)).map(name => name.slice(0, 24)))];
    for (const stem of stems) {
      try {
        const file = files.includes(`${stem}.json`) ? `${stem}.json` : `${stem}-attempt.json`;
        const raw = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
        const cache = await readCache({ regionId: raw.regionId });
        const successes = Object.values(cache.datasets);
        if (successes.length) cachedRegionCount++;
        const view = withAttempt(present({ regionId: raw.regionId }, cache, configured), await readAttempt({ regionId: raw.regionId }));
        if (view.status === "ready") completeRegionCount++;
        if (view.error) readError = view.error;
        for (const dataset of successes) if (dataset.status === "ready" && (!lastSuccessAt || dataset.retrievedAt > lastSuccessAt)) lastSuccessAt = dataset.retrievedAt;
        if (cache.readError) readError = cache.readError;
      } catch { readError = publicError(problem("CACHE_READ_ERROR")); }
    }
    return { configured, envName: "KOSIS_API_KEY", status: !configured ? "needs_key" : cachedRegionCount ? completeRegionCount === cachedRegionCount && !(lastError || readError) ? "ready" : "partial" : lastError || readError ? "error" : "not_collected", cachedRegionCount, completeRegionCount, datasets: DEFINITIONS.map(publicDefinition), lastSuccessAt, error: lastError || readError, networkAttempted: false, requestPolicy: { minIntervalMs: interval, concurrency: 1, dailyBudget: budgetLimit, cooldownMs: Math.max(0, cooldownMs) } };
  }
  return { status, getRegion, refreshRegion };
}

module.exports = { createKosisService, DEFINITIONS, parseValue, mapRegion, normalizeData };
