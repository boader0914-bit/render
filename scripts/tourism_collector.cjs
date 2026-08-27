const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SOURCE_DEFS = [
  {
    key: "visitors",
    label: "regional visitors",
    envPrefix: "KTO_TOURISM_VISITOR",
    serviceKeyEnv: "DATA_GO_KR_VISITOR_SERVICE_KEY",
    referenceUrl: "https://www.data.go.kr/data/15101972/openapi.do",
    defaultEndpoint: "https://apis.data.go.kr/B551011/DataLabService/locgoRegnVisitrDDList",
    adapter: "locgo-regn-visitors-v1",
    unit: "sigungu",
    defaultRegionParam: "",
    defaultPeriodParam: ""
  },
  {
    key: "resourceDemand",
    label: "tourism resource demand",
    envPrefix: "KTO_TOURISM_RESOURCE_DEMAND",
    referenceUrl: "https://www.data.go.kr/data/15152138/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "BASE_YM"
  },
  {
    key: "diversity",
    label: "tourism diversity",
    envPrefix: "KTO_TOURISM_DIVERSITY",
    referenceUrl: "https://www.data.go.kr/data/15151365/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "BASE_YM"
  }
];

const DEFAULT_MOBILE_APP = "lodging-datalab";
const DEFAULT_TTL_HOURS = 24 * 7;
const VISITOR_ADAPTER_VERSION = "locgo-regn-visitors-v1";
const VISITOR_SUCCESS_CODES = new Set(["0000", "00"]);
const VISITOR_CATEGORY_CODES = new Set(["1", "2", "3"]);
const VISITOR_PAGE_SIZE = 10000;
const VISITOR_MAX_PAGES = 50;
const VISITOR_HISTORY_DEFAULT_MONTHS = 36;
const VISITOR_HISTORY_MAX_MONTHS = 36;
const VISITOR_HISTORY_DEFAULT_CONCURRENCY = 2;
const VISITOR_HISTORY_MAX_CONCURRENCY = 4;
const VISITOR_OUTLOOK_MODEL_VERSION = "visitor-outlook-v1";
const VISITOR_OUTLOOK_SCORE_MINIMUMS = Object.freeze({
  minimumCompleteMonths: 24,
  recentWindowMonths: 12,
  minimumRecentCompleteMonths: 10,
  previousWindowMonths: 12,
  minimumPreviousCompleteMonths: 10,
  minimumComparableMonthPairs: 10,
  requireLatestComplete: true,
  requirePreviousYearSameMonthComplete: true
});

function compactText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
}

function stripBusinessWords(value = "") {
  return compactText(value)
    .replace(/글램핑|캠핑장|캠핑|카라반|펜션|풀빌라|숙박|숙소|호텔|리조트|모텔|야영장|오토캠핑|스테이|빌리지/g, "")
    .replace(/특별자치도|특별자치시|광역시|특별시|자치시|자치도|시|군|구|도$/g, "");
}

function safeName(value = "") {
  return compactText(value).slice(0, 80) || "unknown";
}

function parseJsonEnv(name, fallback = {}, env = process.env) {
  const raw = String(env[name] || "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env[name] || "").trim();
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function numberEnv(name, fallback, env = process.env) {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestClosedYearMonth(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(1);
  kst.setUTCMonth(kst.getUTCMonth() - 1);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeYearMonth(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 6) {
    const normalized = digits.slice(0, 6);
    const month = Number(normalized.slice(4, 6));
    if (month >= 1 && month <= 12) return normalized;
  }
  return latestClosedYearMonth();
}

function monthDateRange(value = "") {
  const yearMonth = normalizeYearMonth(value);
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    yearMonth,
    startYmd: `${yearMonth}01`,
    endYmd: `${yearMonth}${String(lastDay).padStart(2, "0")}`,
    expectedDays: lastDay
  };
}

function shiftYearMonth(value = "", offset = 0) {
  const yearMonth = normalizeYearMonth(value);
  const date = new Date(Date.UTC(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(4, 6)) - 1 + Number(offset || 0), 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function visitorHistoryMonths(endYearMonth = "", count = VISITOR_HISTORY_DEFAULT_MONTHS) {
  const safeCount = Math.max(1, Math.min(VISITOR_HISTORY_MAX_MONTHS, Math.round(Number(count) || VISITOR_HISTORY_DEFAULT_MONTHS)));
  const normalizedEnd = normalizeYearMonth(endYearMonth);
  return Array.from({ length: safeCount }, (_, index) => shiftYearMonth(normalizedEnd, index - safeCount + 1));
}

function roundNumber(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function normalizedGrowthScore(changeRate, cap = 0.25) {
  if (!Number.isFinite(changeRate) || !Number.isFinite(cap) || cap <= 0) return null;
  const bounded = Math.max(-cap, Math.min(cap, changeRate));
  return roundNumber(((bounded + cap) / (cap * 2)) * 100, 1);
}

function percentileScore(value, peerValues = []) {
  if (!Number.isFinite(value)) return null;
  const finitePeers = peerValues.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finitePeers.length) return null;
  if (finitePeers.length === 1) return 50;
  const lowerCount = finitePeers.filter((entry) => entry < value).length;
  const equalCount = finitePeers.filter((entry) => entry === value).length;
  if (!equalCount) return null;
  return roundNumber(((lowerCount + ((equalCount - 1) / 2)) / (finitePeers.length - 1)) * 100, 1);
}

function selectedSources(value) {
  const all = DEFAULT_SOURCE_DEFS.map((source) => source.key);
  if (!value) return all;
  if (!Array.isArray(value) && typeof value === "object") {
    const keys = Object.keys(value).filter((item) => all.includes(item));
    return keys.length ? keys : all;
  }
  const input = Array.isArray(value) ? value : String(value).split(",");
  const selected = input.map((item) => String(item || "").trim()).filter(Boolean);
  return selected.length ? selected.filter((item) => all.includes(item)) : all;
}

function dataGoKrServiceKey(env = process.env) {
  return String(
    env.DATA_GO_KR_SERVICE_KEY ||
    env.KTO_DATA_GO_KR_SERVICE_KEY ||
    env.KTO_TOURISM_SERVICE_KEY ||
    ""
  ).trim();
}

function sourceServiceKey(source = {}, env = process.env) {
  const dedicated = source.serviceKeyEnv
    ? String(env[source.serviceKeyEnv] || "").trim()
    : "";
  return dedicated || dataGoKrServiceKey(env);
}

function sourceConfig(def, env = process.env) {
  const prefix = def.envPrefix;
  return {
    ...def,
    endpoint: String(env[`${prefix}_ENDPOINT`] || def.defaultEndpoint || "").trim(),
    enabled: !/^(0|false|off)$/i.test(String(env[`${prefix}_ENABLED`] || "1").trim()),
    regionParam: String(env[`${prefix}_REGION_PARAM`] || def.defaultRegionParam).trim(),
    periodParam: String(env[`${prefix}_PERIOD_PARAM`] || def.defaultPeriodParam).trim(),
    serviceKeyParam: String(env[`${prefix}_SERVICE_KEY_PARAM`] || env.KTO_TOURISM_SERVICE_KEY_PARAM || "serviceKey").trim(),
    extraParams: {
      _type: "json",
      MobileOS: "ETC",
      MobileApp: String(env.KTO_TOURISM_MOBILE_APP || DEFAULT_MOBILE_APP).trim(),
      pageNo: "1",
      numOfRows: "100",
      ...parseJsonEnv(`${prefix}_PARAMS`, {}, env),
      ...parseJsonEnv("KTO_TOURISM_COMMON_PARAMS", {}, env)
    },
    timeoutMs: numberEnv(`${prefix}_TIMEOUT_MS`, numberEnv("KTO_TOURISM_TIMEOUT_MS", 15000, env), env)
  };
}

function sourceStatus(config, serviceKey) {
  if (!config.enabled) return "disabled";
  if (!serviceKey) return "missing_service_key";
  if (!config.endpoint) return "missing_endpoint";
  return "ready";
}

function createCollector(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const rootDir = options.rootDir || process.cwd();
  const webDir = options.webDir || path.join(rootDir, "web");
  const dataDir = options.dataDir || rootDir;
  const tourismDataDir = options.tourismDataDir || path.join(dataDir, "tourism_data");
  const cacheDir = path.join(tourismDataDir, "cache");
  const logFile = path.join(tourismDataDir, "collections.jsonl");
  const regionMapFile = options.regionMapFile || path.join(webDir, "data", "tourism_region_map.json");

  function currentDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  async function readRegionMap() {
    const raw = await fsp.readFile(regionMapFile, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return {
      ...parsed,
      regions: Array.isArray(parsed.regions) ? parsed.regions : [],
      provinceAliases: parsed.provinceAliases || {}
    };
  }

  function regionValues(region = {}) {
    return [
      region.regionKey,
      region.sido,
      region.sidoFull,
      region.sigungu,
      ...(region.aliases || [])
    ].filter(Boolean);
  }

  async function resolveRegion(input = {}) {
    const regionMap = await readRegionMap();
    const regions = regionMap.regions || [];
    const regionKey = String(input.regionKey || "").trim();
    if (regionKey) {
      const direct = regions.find((region) => region.regionKey === regionKey);
      if (direct) return { region: direct, confidence: 100, reason: "region-key", regionMap };
    }

    const query = String(input.keyword || input.query || input.searchKeyword || "").trim();
    const base = stripBusinessWords(query);
    const scored = regions
      .map((region) => {
        let score = 0;
        for (const value of regionValues(region)) {
          const compact = compactText(value);
          const stripped = stripBusinessWords(value);
          if (query && compactText(query) === compact) score = Math.max(score, 100);
          if (base && stripped && base === stripped) score = Math.max(score, 94);
          if (base && stripped && (base.includes(stripped) || stripped.includes(base))) score = Math.max(score, 78);
          if (query && compact && (compactText(query).includes(compact) || compact.includes(compactText(query)))) score = Math.max(score, 72);
        }
        return { region, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.region.matchPriority || 0) - Number(a.region.matchPriority || 0));

    const best = scored[0];
    return {
      region: best?.region || null,
      confidence: best?.score || 0,
      reason: best ? "keyword" : "missing",
      regionMap
    };
  }

  function cacheKey({ region = {}, yearMonth = "", sources = [] } = {}) {
    return [
      safeName(region.regionKey || region.sigungu || "region"),
      normalizeYearMonth(yearMonth),
      selectedSources(sources).join("-")
    ].join("__");
  }

  function cachePath(input = {}) {
    return path.join(cacheDir, `${cacheKey(input)}.json`);
  }

  async function readCache(input = {}) {
    const filePath = cachePath(input);
    try {
      const parsed = JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
      return { hit: true, filePath, data: parsed };
    } catch {
      return { hit: false, filePath, data: null };
    }
  }

  function cacheFresh(snapshot = {}, ttlHours = DEFAULT_TTL_HOURS) {
    const collectedAt = Date.parse(snapshot.collectedAt || "");
    if (!Number.isFinite(collectedAt)) return false;
    return currentDate().getTime() - collectedAt < ttlHours * 60 * 60 * 1000;
  }

  async function writeSnapshot(snapshot = {}) {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.mkdir(tourismDataDir, { recursive: true });
    const filePath = cachePath(snapshot);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fsp.rename(tempPath, filePath);
    await fsp.appendFile(logFile, `${JSON.stringify({
      collectedAt: snapshot.collectedAt,
      regionKey: snapshot.region?.regionKey || "",
      yearMonth: snapshot.yearMonth || "",
      sourceCount: Object.keys(snapshot.sources || {}).length,
      cacheKey: cacheKey(snapshot)
    })}\n`, "utf8");
    return filePath;
  }

  function buildUrl(config, region, yearMonth) {
    const url = new URL(config.endpoint);
    const params = {
      ...config.extraParams,
      [config.regionParam]: region.ktoSggCd,
      [config.periodParam]: yearMonth
    };
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
    });

    const serviceKey = dataGoKrServiceKey(env);
    if (serviceKey) {
      const connector = url.toString().includes("?") ? "&" : "?";
      const keyValue = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);
      return `${url.toString()}${connector}${encodeURIComponent(config.serviceKeyParam)}=${keyValue}`;
    }
    return url.toString();
  }

  async function requestSource(config, region, yearMonth) {
    const status = sourceStatus(config, dataGoKrServiceKey(env));
    const requestedAt = new Date().toISOString();
    if (status !== "ready") {
      return { status: "skipped", reason: status, requestedAt, rows: [], raw: null };
    }

    const url = buildUrl(config, region, yearMonth);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { rawText: text };
      }
      return {
        status: response.ok ? "ok" : "error",
        httpStatus: response.status,
        requestedAt,
        endpointConfigured: true,
        rows: normalizeApiRows(parsed),
        raw: parsed
      };
    } catch (error) {
      return {
        status: "error",
        reason: error.name === "AbortError" ? "timeout" : "request_failed",
        message: error.message || String(error),
        requestedAt,
        rows: [],
        raw: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeApiRows(parsed) {
    if (!parsed) return [];
    const candidates = [
      parsed?.response?.body?.items?.item,
      parsed?.response?.body?.items,
      parsed?.body?.items?.item,
      parsed?.body?.items,
      parsed?.items?.item,
      parsed?.items,
      parsed?.data,
      parsed
    ];
    const found = candidates.find((candidate) => Array.isArray(candidate) || (candidate && typeof candidate === "object"));
    if (!found) return [];
    if (Array.isArray(found)) return found;
    if (Array.isArray(found.item)) return found.item;
    return [found];
  }

  function visitorCachePath(yearMonth = "") {
    const regionMapVersion = safeName(options.regionMapVersion || "region-map");
    return path.join(cacheDir, `visitors__${VISITOR_ADAPTER_VERSION}__${regionMapVersion}__${normalizeYearMonth(yearMonth)}.json`);
  }

  async function readVisitorCache(yearMonth = "") {
    const filePath = visitorCachePath(yearMonth);
    try {
      const parsed = JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
      return { hit: true, filePath, data: parsed };
    } catch {
      return { hit: false, filePath, data: null };
    }
  }

  function visitorCacheCompatible(cached = {}, regionMap = {}) {
    return Boolean(
      cached.hit
      && cached.data?.status === "ok"
      && cached.data?.adapter === VISITOR_ADAPTER_VERSION
      && cached.data?.regionMapVersion === regionMap.version
    );
  }

  function visitorSnapshotImproves(current = {}, candidate = {}) {
    if (current?.status !== "ok") return candidate?.status === "ok";
    if (candidate?.status !== "ok") return false;
    const candidateByRegion = new Map((candidate.allRegions || []).map((region) => [region.regionKey, region]));
    let improved = false;
    for (const currentRegion of current.allRegions || []) {
      const candidateRegion = candidateByRegion.get(currentRegion.regionKey);
      const currentComplete = currentRegion?.quality?.status === "complete";
      const candidateComplete = candidateRegion?.quality?.status === "complete";
      if (currentComplete && !candidateComplete) return false;
      if (!currentComplete && candidateComplete) improved = true;
      if (!currentComplete && !candidateComplete) {
        const currentObservedDays = Number(currentRegion?.observedDays || 0);
        const candidateObservedDays = Number(candidateRegion?.observedDays || 0);
        if (candidateObservedDays < currentObservedDays) return false;
        if (candidateObservedDays > currentObservedDays) improved = true;
      }
    }
    return improved;
  }

  async function writeVisitorSnapshot(snapshot = {}) {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.mkdir(tourismDataDir, { recursive: true });
    const filePath = visitorCachePath(snapshot.yearMonth);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fsp.rename(tempPath, filePath);
    await fsp.appendFile(logFile, `${JSON.stringify({
      collectedAt: snapshot.collectedAt,
      source: "visitors",
      adapter: VISITOR_ADAPTER_VERSION,
      yearMonth: snapshot.yearMonth,
      status: snapshot.status,
      rowCount: snapshot.quality?.validRowCount || 0,
      regionCount: snapshot.allRegions?.length || 0
    })}\n`, "utf8");
    return filePath;
  }

  function visitorEndpointStatus(config, serviceKey) {
    if (!config.enabled) return "disabled";
    if (!serviceKey) return "missing_service_key";
    if (!config.endpoint) return "missing_endpoint";
    try {
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "apis.data.go.kr") return "untrusted_endpoint";
      if (!endpoint.pathname.endsWith("/B551011/DataLabService/locgoRegnVisitrDDList")) return "invalid_endpoint";
    } catch {
      return "invalid_endpoint";
    }
    if (typeof fetchImpl !== "function") return "fetch_unavailable";
    return "ready";
  }

  function visitorPageUrl(config, range, pageNo, pageSize, serviceKey) {
    const url = new URL(config.endpoint);
    const params = {
      _type: "json",
      MobileOS: "ETC",
      MobileApp: String(env.KTO_TOURISM_MOBILE_APP || DEFAULT_MOBILE_APP).trim(),
      startYmd: range.startYmd,
      endYmd: range.endYmd,
      pageNo: String(pageNo),
      numOfRows: String(pageSize)
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const connector = url.toString().includes("?") ? "&" : "?";
    const keyValue = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);
    return `${url.toString()}${connector}${encodeURIComponent(config.serviceKeyParam)}=${keyValue}`;
  }

  function visitorGatewayError(parsed) {
    const header = parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader || parsed?.cmmMsgHeader || null;
    if (!header) return null;
    return {
      code: String(header.returnReasonCode || "gateway_error"),
      message: String(header.returnAuthMsg || header.errMsg || "gateway_error")
    };
  }

  function visitorEnvelope(parsed) {
    const gatewayError = visitorGatewayError(parsed);
    if (gatewayError) return { ok: false, reason: "gateway_error", ...gatewayError };
    const envelope = parsed?.response || parsed;
    const header = envelope?.header;
    const body = envelope?.body;
    if (!header || !body || typeof body !== "object") return { ok: false, reason: "schema_error" };
    const resultCode = String(header.resultCode ?? "");
    if (!VISITOR_SUCCESS_CODES.has(resultCode)) {
      return {
        ok: false,
        reason: resultCode === "03" ? "no_observation" : "api_error",
        code: resultCode,
        message: String(header.resultMsg || "api_error")
      };
    }
    const item = body?.items?.item;
    const rows = Array.isArray(item) ? item : (item && typeof item === "object" ? [item] : []);
    const totalCount = Number(body.totalCount);
    const pageNo = Number(body.pageNo);
    const numOfRows = Number(body.numOfRows);
    if (!Number.isFinite(totalCount) || totalCount < 0) return { ok: false, reason: "schema_error" };
    return {
      ok: true,
      rows,
      totalCount,
      pageNo: Number.isFinite(pageNo) ? pageNo : null,
      numOfRows: Number.isFinite(numOfRows) ? numOfRows : null,
      resultCode,
      resultMsg: String(header.resultMsg || "")
    };
  }

  async function requestVisitorPage(config, range, pageNo, pageSize, serviceKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(visitorPageUrl(config, range, pageNo, pageSize, serviceKey), {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
      const responseText = await response.text();
      let parsed = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        return { ok: false, reason: "invalid_response", httpStatus: response.status };
      }
      const envelope = visitorEnvelope(parsed);
      if (!response.ok) {
        return {
          ok: false,
          reason: envelope.reason || "http_error",
          code: envelope.code || "",
          message: envelope.message || "",
          httpStatus: response.status
        };
      }
      return { ...envelope, httpStatus: response.status };
    } catch (error) {
      return {
        ok: false,
        reason: error.name === "AbortError" ? "timeout" : "request_failed",
        message: error.message || String(error)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeVisitorRows(rows = [], range = {}, regionMap = {}) {
    const mapByCode = new Map((regionMap.regions || []).map((region) => [String(region.ktoSggCd || ""), region]));
    const byGrain = new Map();
    const conflictRegionCodes = new Set();
    const nameMismatchRegionCodes = new Set();
    const warnings = [];
    let invalidRowCount = 0;

    for (const raw of rows) {
      const baseYmd = String(raw?.baseYmd || "").replace(/\D/g, "").slice(0, 8);
      const signguCode = String(raw?.signguCode || "").trim();
      const signguNm = String(raw?.signguNm || "").trim();
      const touDivCd = String(raw?.touDivCd || "").trim();
      const touDivNm = String(raw?.touDivNm || "").trim();
      const touNumText = String(raw?.touNum ?? "").replace(/,/g, "").trim();
      const touNum = touNumText === "" ? NaN : Number(touNumText);
      if (!/^\d{8}$/.test(baseYmd) || !/^\d{5}$/.test(signguCode) || !VISITOR_CATEGORY_CODES.has(touDivCd) || !Number.isFinite(touNum) || touNum < 0) {
        invalidRowCount += 1;
        continue;
      }
      if (baseYmd < range.startYmd || baseYmd > range.endYmd) {
        invalidRowCount += 1;
        continue;
      }
      const mapped = mapByCode.get(signguCode);
      if (!mapped) continue;
      if (compactText(signguNm) && compactText(mapped.sigungu) !== compactText(signguNm)) {
        nameMismatchRegionCodes.add(signguCode);
        continue;
      }
      const grain = `${baseYmd}|${signguCode}|${touDivCd}`;
      const current = byGrain.get(grain);
      const normalized = { baseYmd, signguCode, signguNm, touDivCd, touDivNm, touNum };
      if (!current) {
        byGrain.set(grain, normalized);
      } else if (current.touNum !== touNum) {
        conflictRegionCodes.add(signguCode);
      } else {
        warnings.push(`duplicate:${grain}`);
      }
    }

    const dailyByRegion = new Map();
    for (const row of byGrain.values()) {
      if (conflictRegionCodes.has(row.signguCode) || nameMismatchRegionCodes.has(row.signguCode)) continue;
      const regionDays = dailyByRegion.get(row.signguCode) || new Map();
      const day = regionDays.get(row.baseYmd) || { baseYmd: row.baseYmd, categories: {} };
      day.categories[row.touDivCd] = {
        code: row.touDivCd,
        label: row.touDivNm,
        visitors: row.touNum
      };
      regionDays.set(row.baseYmd, day);
      dailyByRegion.set(row.signguCode, regionDays);
    }

    const allRegions = (regionMap.regions || []).map((region) => {
      const code = String(region.ktoSggCd || "");
      const regionDays = [...(dailyByRegion.get(code)?.values() || [])].sort((a, b) => a.baseYmd.localeCompare(b.baseYmd));
      const completeDays = regionDays.filter((day) => ["1", "2", "3"].every((category) => Number.isFinite(day.categories[category]?.visitors)));
      const observedDays = completeDays.length;
      const visitorDays = completeDays.reduce((sum, day) => sum + ["1", "2", "3"].reduce((daySum, category) => daySum + day.categories[category].visitors, 0), 0);
      const categoryTotals = Object.fromEntries(["1", "2", "3"].map((category) => [
        category,
        completeDays.reduce((sum, day) => sum + day.categories[category].visitors, 0)
      ]));
      const codeStatus = region.codeStatus || "";
      let qualityStatus = "complete";
      let reason = "";
      if (codeStatus) {
        qualityStatus = "region_code_verify_required";
        reason = codeStatus;
      } else if (conflictRegionCodes.has(code)) {
        qualityStatus = "conflicting_rows";
        reason = "duplicate_value_conflict";
      } else if (nameMismatchRegionCodes.has(code)) {
        qualityStatus = "region_name_mismatch";
        reason = "code_name_mismatch";
      } else if (!observedDays) {
        qualityStatus = "no_observation";
        reason = "no_rows_for_region";
      } else if (observedDays !== range.expectedDays) {
        qualityStatus = "partial";
        reason = "incomplete_date_coverage";
      }
      return {
        regionKey: region.regionKey,
        sido: region.sido,
        sigungu: region.sigungu,
        signguCode: code,
        yearMonth: range.yearMonth,
        observedDays,
        expectedDays: range.expectedDays,
        coverageRate: range.expectedDays ? Number((observedDays / range.expectedDays).toFixed(4)) : null,
        averageDailyVisitors: qualityStatus === "complete" ? Math.round(visitorDays / observedDays) : null,
        visitorDays: qualityStatus === "complete" ? Math.round(visitorDays) : null,
        categoryDailyAverages: qualityStatus === "complete"
          ? Object.fromEntries(Object.entries(categoryTotals).map(([category, total]) => [category, Math.round(total / observedDays)]))
          : {},
        quality: { status: qualityStatus, reason }
      };
    });

    return {
      allRegions,
      quality: {
        sourceRowCount: rows.length,
        validRowCount: byGrain.size,
        invalidRowCount,
        duplicateRowCount: warnings.length,
        conflictingRegionCount: conflictRegionCodes.size,
        nameMismatchRegionCount: nameMismatchRegionCodes.size
      }
    };
  }

  function requestedVisitorRegions(regionMap = {}, input = {}) {
    const listValue = (value) => Array.isArray(value) ? value : (value === undefined || value === null || value === "" ? [] : [value]);
    const directKeys = new Set(listValue(input.regionKeys).map((value) => String(value || "").trim()).filter(Boolean));
    const requestedNames = listValue(input.regionNames || input.regions)
      .map((value) => String(typeof value === "object" ? (value.region || value.name || value.sigungu || "") : value || "").trim())
      .filter(Boolean);
    const normalizedNames = requestedNames.map((value) => stripBusinessWords(value).replace(/권역|권$/g, ""));
    const matchesName = (left, right) => Boolean(left && right && (
      left === right
      || (Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left)))
    ));
    let selected = (regionMap.regions || []).filter((region) => directKeys.has(region.regionKey));
    for (const name of normalizedNames) {
      const matches = (regionMap.regions || []).filter((region) => regionValues(region).some((value) => {
        const normalized = stripBusinessWords(value).replace(/권역|권$/g, "");
        return matchesName(normalized, name);
      }));
      matches.forEach((region) => {
        if (!selected.some((entry) => entry.regionKey === region.regionKey)) selected.push(region);
      });
    }
    if (!selected.length && input.regionKey) {
      selected = (regionMap.regions || []).filter((region) => region.regionKey === input.regionKey);
    }
    return {
      selected,
      requestedNames,
      unmatchedNames: requestedNames.filter((name) => !selected.some((region) => regionValues(region).some((value) => {
        const left = stripBusinessWords(value).replace(/권역|권$/g, "");
        const right = stripBusinessWords(name).replace(/권역|권$/g, "");
        return matchesName(left, right);
      })))
    };
  }

  function publicVisitorSnapshot(snapshot = {}, regionMap = {}, input = {}, cache = {}) {
    const requested = requestedVisitorRegions(regionMap, input);
    const selectedKeys = new Set(requested.selected.map((region) => region.regionKey));
    const hasSelector = Boolean(
      (Array.isArray(input.regionKeys) ? input.regionKeys.length : input.regionKeys)
      || (Array.isArray(input.regionNames) ? input.regionNames.length : input.regionNames)
      || (Array.isArray(input.regions) ? input.regions.length : input.regions)
      || input.regionKey
    );
    const regions = (snapshot.allRegions || []).filter((region) => !hasSelector || selectedKeys.has(region.regionKey));
    return {
      ok: snapshot.status === "ok",
      status: snapshot.status || "unavailable",
      reason: snapshot.reason || "",
      schemaVersion: snapshot.schemaVersion || 1,
      adapter: VISITOR_ADAPTER_VERSION,
      yearMonth: snapshot.yearMonth || normalizeYearMonth(input.yearMonth),
      period: snapshot.period || monthDateRange(input.yearMonth),
      collectedAt: snapshot.collectedAt || "",
      source: {
        key: "visitors",
        label: "한국관광공사 지역별 방문자수",
        referenceUrl: DEFAULT_SOURCE_DEFS[0].referenceUrl,
        unit: "기초지자체",
        metric: "완전월 일평균 순방문자",
        categories: ["현지인", "외지인", "외국인"]
      },
      quality: snapshot.quality || {},
      regions,
      unmatchedRegions: requested.unmatchedNames,
      cache: {
        hit: Boolean(cache.hit),
        ttlHours: Number(cache.ttlHours || DEFAULT_TTL_HOURS)
      },
      policy: {
        scoreApplied: false,
        noSidoSigunguAggregation: true,
        missingIsNotZero: true,
        dailyUniqueVisitorCaveat: true
      }
    };
  }

  async function collectVisitorCounts(input = {}) {
    const range = monthDateRange(input.yearMonth || input.period || input.baseYm);
    const ttlHours = Number.isFinite(Number(input.ttlHours)) ? Number(input.ttlHours) : DEFAULT_TTL_HOURS;
    const force = Boolean(input.force);
    const regionMap = await readRegionMap();
    const config = sourceConfig(DEFAULT_SOURCE_DEFS[0], env);
    const serviceKey = sourceServiceKey(config, env);
    const configStatus = visitorEndpointStatus(config, serviceKey);
    if (configStatus !== "ready") {
      return publicVisitorSnapshot({
        status: "unavailable",
        reason: configStatus,
        yearMonth: range.yearMonth,
        period: range,
        collectedAt: "",
        allRegions: []
      }, regionMap, input, { hit: false, ttlHours });
    }

    const cached = await readVisitorCache(range.yearMonth);
    const immutableClosedMonth = range.yearMonth <= latestClosedYearMonth(currentDate());
    if (!force
      && visitorCacheCompatible(cached, regionMap)
      && (immutableClosedMonth || cacheFresh(cached.data, ttlHours))) {
      return publicVisitorSnapshot(cached.data, regionMap, input, { hit: true, ttlHours });
    }

    const pageSize = Math.max(100, Math.min(10000, Math.round(numberEnv("KTO_TOURISM_VISITOR_PAGE_SIZE", VISITOR_PAGE_SIZE, env))));
    const maxPages = Math.max(1, Math.min(100, Math.round(numberEnv("KTO_TOURISM_VISITOR_MAX_PAGES", VISITOR_MAX_PAGES, env))));
    const rows = [];
    let totalCount = null;
    let pageCount = 0;
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const page = await requestVisitorPage(config, range, pageNo, pageSize, serviceKey);
      if (!page.ok) {
        return publicVisitorSnapshot({
          status: page.reason === "no_observation" ? "no_observation" : "error",
          reason: page.reason,
          yearMonth: range.yearMonth,
          period: range,
          collectedAt: "",
          quality: { pageCount, httpStatus: page.httpStatus || null, apiCode: page.code || "" },
          allRegions: []
        }, regionMap, input, { hit: false, ttlHours });
      }
      if (page.pageNo !== null && page.pageNo !== pageNo) {
        return publicVisitorSnapshot({
          status: "error",
          reason: "page_number_mismatch",
          yearMonth: range.yearMonth,
          period: range,
          collectedAt: "",
          quality: { pageCount },
          allRegions: []
        }, regionMap, input, { hit: false, ttlHours });
      }
      if (totalCount === null) totalCount = page.totalCount;
      if (page.totalCount !== totalCount) {
        return publicVisitorSnapshot({
          status: "error",
          reason: "total_count_changed",
          yearMonth: range.yearMonth,
          period: range,
          collectedAt: "",
          quality: { pageCount },
          allRegions: []
        }, regionMap, input, { hit: false, ttlHours });
      }
      pageCount += 1;
      rows.push(...page.rows);
      if (rows.length >= totalCount) break;
      if (!page.rows.length) {
        return publicVisitorSnapshot({
          status: "error",
          reason: "incomplete_pagination",
          yearMonth: range.yearMonth,
          period: range,
          collectedAt: "",
          quality: { pageCount, totalCount, receivedRows: rows.length },
          allRegions: []
        }, regionMap, input, { hit: false, ttlHours });
      }
    }
    if (totalCount === null || rows.length < totalCount) {
      return publicVisitorSnapshot({
        status: "error",
        reason: "page_limit_exceeded",
        yearMonth: range.yearMonth,
        period: range,
        collectedAt: "",
        quality: { pageCount, totalCount, receivedRows: rows.length },
        allRegions: []
      }, regionMap, input, { hit: false, ttlHours });
    }
    if (!totalCount) {
      return publicVisitorSnapshot({
        status: "no_observation",
        reason: "empty_verified",
        yearMonth: range.yearMonth,
        period: range,
        collectedAt: currentDate().toISOString(),
        quality: { pageCount, totalCount: 0, sourceRowCount: 0 },
        allRegions: []
      }, regionMap, input, { hit: false, ttlHours });
    }

    const normalized = normalizeVisitorRows(rows.slice(0, totalCount), range, regionMap);
    const snapshot = {
      schemaVersion: 1,
      adapter: VISITOR_ADAPTER_VERSION,
      regionMapVersion: regionMap.version || "",
      status: "ok",
      reason: "",
      collectedAt: currentDate().toISOString(),
      yearMonth: range.yearMonth,
      period: range,
      quality: {
        ...normalized.quality,
        pageCount,
        totalCount,
        receivedRows: rows.length
      },
      allRegions: normalized.allRegions,
      source: {
        referenceUrl: DEFAULT_SOURCE_DEFS[0].referenceUrl,
        operation: "locgoRegnVisitrDDList"
      }
    };
    if (visitorCacheCompatible(cached, regionMap) && !visitorSnapshotImproves(cached.data, snapshot)) {
      return publicVisitorSnapshot(cached.data, regionMap, input, { hit: true, ttlHours });
    }
    const filePath = await writeVisitorSnapshot(snapshot);
    return publicVisitorSnapshot(snapshot, regionMap, input, { hit: false, ttlHours, filePath });
  }

  function missingVisitorMonth(yearMonth, reason = "monthly_cache_missing") {
    return {
      ok: false,
      status: "unavailable",
      reason,
      schemaVersion: 1,
      adapter: VISITOR_ADAPTER_VERSION,
      yearMonth,
      period: monthDateRange(yearMonth),
      collectedAt: "",
      quality: {},
      regions: [],
      unmatchedRegions: [],
      cache: { hit: false, ttlHours: DEFAULT_TTL_HOURS },
      policy: {
        scoreApplied: false,
        noSidoSigunguAggregation: true,
        missingIsNotZero: true,
        dailyUniqueVisitorCaveat: true
      }
    };
  }

  async function visitorMonthForHistory(yearMonth, regionMap, input = {}) {
    const cached = await readVisitorCache(yearMonth);
    const compatible = visitorCacheCompatible(cached, regionMap);
    const cachedRegions = new Map((cached.data?.allRegions || []).map((region) => [region.regionKey, region]));
    const retryCachedIncomplete = Boolean(
      compatible
      && input.collectMissing
      && input.retryIncomplete
      && (input.regionKeys || []).length
      && input.regionKeys.some((regionKey) => cachedRegions.get(regionKey)?.quality?.status !== "complete")
    );
    if (compatible && !input.force && !retryCachedIncomplete) {
      return {
        yearMonth,
        access: "cache",
        snapshot: publicVisitorSnapshot(cached.data, regionMap, {}, { hit: true, ttlHours: input.ttlHours })
      };
    }
    if (!input.force && !input.collectMissing) {
      return {
        yearMonth,
        access: "missing",
        snapshot: missingVisitorMonth(yearMonth, compatible ? "cache_refresh_required" : "monthly_cache_missing")
      };
    }
    try {
      const fetchedSnapshot = await collectVisitorCounts({
        yearMonth,
        force: Boolean(input.force || retryCachedIncomplete),
        ttlHours: input.ttlHours
      });
      if (fetchedSnapshot.status !== "ok" && compatible) {
        return {
          yearMonth,
          access: "network",
          networkSucceeded: false,
          retriedIncomplete: retryCachedIncomplete,
          refreshError: fetchedSnapshot.reason || fetchedSnapshot.status,
          snapshot: publicVisitorSnapshot(cached.data, regionMap, {}, { hit: true, ttlHours: input.ttlHours })
        };
      }
      return {
        yearMonth,
        access: "network",
        networkSucceeded: fetchedSnapshot.status === "ok",
        retriedIncomplete: retryCachedIncomplete,
        snapshot: fetchedSnapshot
      };
    } catch (error) {
      return {
        yearMonth,
        access: "network",
        snapshot: missingVisitorMonth(yearMonth, error?.message || "history_collection_failed")
      };
    }
  }

  function visitorHistoryPoint(monthResult = {}, region = {}) {
    const snapshot = monthResult.snapshot || {};
    const row = (snapshot.regions || []).find((entry) => entry.regionKey === region.regionKey);
    const rowQualityStatus = String(row?.quality?.status || "");
    const complete = rowQualityStatus === "complete" && Number.isFinite(row?.averageDailyVisitors);
    const partial = rowQualityStatus === "partial";
    let reason = "";
    if (!complete) {
      reason = String(
        row?.quality?.reason
        || snapshot.reason
        || (row ? rowQualityStatus : "region_observation_missing")
        || "region_observation_missing"
      );
    }
    return {
      yearMonth: monthResult.yearMonth,
      status: complete ? "complete" : partial ? "partial" : "missing",
      reason,
      qualityStatus: rowQualityStatus || (snapshot.status === "ok" ? "no_observation" : snapshot.status || "unavailable"),
      averageDailyVisitors: complete ? Number(row.averageDailyVisitors) : null,
      visitorDays: complete && Number.isFinite(row.visitorDays) ? Number(row.visitorDays) : null,
      observedDays: Number.isFinite(row?.observedDays) ? Number(row.observedDays) : 0,
      expectedDays: Number.isFinite(row?.expectedDays) ? Number(row.expectedDays) : monthDateRange(monthResult.yearMonth).expectedDays,
      coverageRate: Number.isFinite(row?.coverageRate) ? Number(row.coverageRate) : 0,
      collectedAt: String(snapshot.collectedAt || ""),
      cacheHit: monthResult.access === "cache"
    };
  }

  function coverageWindow(series = []) {
    const expectedMonths = series.length;
    const completeMonths = series.filter((point) => point.status === "complete").length;
    const partialMonths = series.filter((point) => point.status === "partial").length;
    const missingMonths = expectedMonths - completeMonths - partialMonths;
    return {
      expectedMonths,
      completeMonths,
      partialMonths,
      missingMonths,
      coverageRate: expectedMonths ? roundNumber(completeMonths / expectedMonths, 4) : 0
    };
  }

  function visitorGrowthComparison(currentSeries = [], previousSeries = [], currentLabel = "recent_12", previousLabel = "previous_12") {
    const pairCount = Math.min(currentSeries.length, previousSeries.length);
    const comparablePairs = [];
    for (let index = 0; index < pairCount; index += 1) {
      const current = currentSeries[index];
      const previous = previousSeries[index];
      if (current?.status === "complete" && previous?.status === "complete") {
        comparablePairs.push({ current, previous });
      }
    }
    const currentAverage = comparablePairs.length
      ? roundNumber(comparablePairs.reduce((sum, pair) => sum + pair.current.averageDailyVisitors, 0) / comparablePairs.length, 2)
      : null;
    const previousAverage = comparablePairs.length
      ? roundNumber(comparablePairs.reduce((sum, pair) => sum + pair.previous.averageDailyVisitors, 0) / comparablePairs.length, 2)
      : null;
    if (!Number.isFinite(currentAverage) || !Number.isFinite(previousAverage) || previousAverage <= 0) {
      return {
        status: "insufficient_data",
        reason: "comparable_average_unavailable",
        comparableMonthPairs: comparablePairs.length,
        comparedMonths: comparablePairs.map((pair) => ({
          currentYearMonth: pair.current.yearMonth,
          previousYearMonth: pair.previous.yearMonth
        })),
        currentAverage,
        previousAverage,
        changeRate: null,
        changePercent: null
      };
    }
    const changeRate = (currentAverage - previousAverage) / previousAverage;
    return {
      status: "ready",
      reason: "",
      currentLabel,
      previousLabel,
      comparableMonthPairs: comparablePairs.length,
      comparedMonths: comparablePairs.map((pair) => ({
        currentYearMonth: pair.current.yearMonth,
        previousYearMonth: pair.previous.yearMonth
      })),
      currentAverage,
      previousAverage,
      changeRate: roundNumber(changeRate, 6),
      changePercent: roundNumber(changeRate * 100, 2)
    };
  }

  function visitorSameMonthComparison(series = [], endYearMonth = "") {
    const byMonth = new Map(series.map((point) => [point.yearMonth, point]));
    const current = byMonth.get(endYearMonth);
    const previousYearMonth = shiftYearMonth(endYearMonth, -12);
    const previous = byMonth.get(previousYearMonth);
    if (current?.status !== "complete" || previous?.status !== "complete" || Number(previous.averageDailyVisitors) <= 0) {
      return {
        status: "insufficient_data",
        reason: current?.status !== "complete" ? "latest_month_incomplete" : "previous_year_same_month_incomplete",
        currentYearMonth: endYearMonth,
        previousYearMonth,
        currentValue: current?.status === "complete" ? current.averageDailyVisitors : null,
        previousValue: previous?.status === "complete" ? previous.averageDailyVisitors : null,
        changeRate: null,
        changePercent: null
      };
    }
    const changeRate = (current.averageDailyVisitors - previous.averageDailyVisitors) / previous.averageDailyVisitors;
    return {
      status: "ready",
      reason: "",
      currentYearMonth: endYearMonth,
      previousYearMonth,
      currentValue: current.averageDailyVisitors,
      previousValue: previous.averageDailyVisitors,
      changeRate: roundNumber(changeRate, 6),
      changePercent: roundNumber(changeRate * 100, 2)
    };
  }

  function visitorOutlookLabel(score) {
    if (!Number.isFinite(score)) return "자료 부족";
    if (score >= 60) return "상승 흐름";
    if (score < 40) return "감소 흐름";
    return "보합 흐름";
  }

  function visitorOutlook(series = [], coverage = {}, latestMonthSnapshot = {}, endYearMonth = "") {
    const recentSeries = series.slice(-VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths);
    const previousSeries = series.slice(
      -(VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths + VISITOR_OUTLOOK_SCORE_MINIMUMS.previousWindowMonths),
      -VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths
    );
    const latest = series.find((point) => point.yearMonth === endYearMonth);
    const previousSameMonth = series.find((point) => point.yearMonth === shiftYearMonth(endYearMonth, -12));
    const momentum = visitorGrowthComparison(recentSeries, previousSeries);
    const yoy = visitorSameMonthComparison(series, endYearMonth);
    const peerValues = (latestMonthSnapshot.regions || [])
      .filter((entry) => entry?.quality?.status === "complete")
      .map((entry) => Number(entry.averageDailyVisitors))
      .filter(Number.isFinite);
    const peerPercentile = latest?.status === "complete"
      ? percentileScore(Number(latest.averageDailyVisitors), peerValues)
      : null;
    const momentumScore = normalizedGrowthScore(momentum.changeRate, 0.25);
    const yoyScore = normalizedGrowthScore(yoy.changeRate, 0.25);
    const reasons = [];
    if (coverage.completeMonths < VISITOR_OUTLOOK_SCORE_MINIMUMS.minimumCompleteMonths) reasons.push("complete_months_below_24");
    if (coverage.recent12.completeMonths < VISITOR_OUTLOOK_SCORE_MINIMUMS.minimumRecentCompleteMonths) reasons.push("recent_12_complete_months_below_10");
    if (coverage.previous12.completeMonths < VISITOR_OUTLOOK_SCORE_MINIMUMS.minimumPreviousCompleteMonths) reasons.push("previous_12_complete_months_below_10");
    if (momentum.comparableMonthPairs < VISITOR_OUTLOOK_SCORE_MINIMUMS.minimumComparableMonthPairs) reasons.push("comparable_month_pairs_below_10");
    if (latest?.status !== "complete") reasons.push("latest_month_incomplete");
    if (previousSameMonth?.status !== "complete") reasons.push("previous_year_same_month_incomplete");
    if (!Number.isFinite(peerPercentile)) reasons.push("latest_peer_percentile_unavailable");
    if (!Number.isFinite(momentumScore)) reasons.push("recent_momentum_unavailable");
    if (!Number.isFinite(yoyScore)) reasons.push("same_month_yoy_unavailable");

    const components = [
      {
        key: "latest_peer_percentile",
        label: "최신 완전월 전체 매핑지역 내 위치",
        weight: 0.4,
        rawValue: Number.isFinite(peerPercentile) ? peerPercentile : null,
        score: Number.isFinite(peerPercentile) ? peerPercentile : null,
        source: {
          yearMonth: endYearMonth,
          metric: "averageDailyVisitors",
          peerCount: peerValues.length,
          method: "midrank_percentile"
        }
      },
      {
        key: "recent12_vs_previous12",
        label: "최근 12개월과 직전 12개월 변화",
        weight: 0.35,
        rawValue: momentum.changeRate,
        score: momentumScore,
        source: {
          recentStartYearMonth: recentSeries[0]?.yearMonth || "",
          recentEndYearMonth: recentSeries.at(-1)?.yearMonth || "",
          previousStartYearMonth: previousSeries[0]?.yearMonth || "",
          previousEndYearMonth: previousSeries.at(-1)?.yearMonth || "",
          recentCompleteMonths: coverage.recent12.completeMonths,
          previousCompleteMonths: coverage.previous12.completeMonths,
          comparableMonthPairs: momentum.comparableMonthPairs,
          comparisonMethod: "same_calendar_month_pairs_only",
          normalization: "-25%..+25%=0..100"
        }
      },
      {
        key: "latest_same_month_yoy",
        label: "최신월 전년동월 변화",
        weight: 0.25,
        rawValue: yoy.changeRate,
        score: yoyScore,
        source: {
          currentYearMonth: endYearMonth,
          previousYearMonth: shiftYearMonth(endYearMonth, -12),
          normalization: "-25%..+25%=0..100"
        }
      }
    ];
    const ready = reasons.length === 0;
    const score = ready
      ? roundNumber(components.reduce((sum, component) => sum + (component.score * component.weight), 0), 1)
      : null;
    return {
      status: ready ? "ready" : "insufficient_data",
      eligible: ready,
      score,
      reason: ready ? "minimum_coverage_met" : reasons[0],
      reasons,
      label: visitorOutlookLabel(score),
      modelVersion: VISITOR_OUTLOOK_MODEL_VERSION,
      basis: "관측기반 수요전망 보조점수",
      isForecast: false,
      components
    };
  }

  async function collectVisitorHistory(input = {}) {
    const regionMap = await readRegionMap();
    const closedYearMonth = latestClosedYearMonth(currentDate());
    const requestedEndYearMonth = normalizeYearMonth(input.endYearMonth || input.yearMonth || closedYearMonth);
    const endYearMonth = requestedEndYearMonth > closedYearMonth ? closedYearMonth : requestedEndYearMonth;
    const monthCount = Math.max(1, Math.min(
      VISITOR_HISTORY_MAX_MONTHS,
      Math.round(Number(input.months) || VISITOR_HISTORY_DEFAULT_MONTHS)
    ));
    const months = visitorHistoryMonths(endYearMonth, monthCount);
    const collectMissing = Boolean(input.collectMissing || input.refresh);
    const retryIncomplete = collectMissing && input.retryIncomplete !== false;
    const force = Boolean(input.force);
    const ttlHours = Number.isFinite(Number(input.ttlHours)) ? Number(input.ttlHours) : DEFAULT_TTL_HOURS;
    const concurrency = Math.max(1, Math.min(
      VISITOR_HISTORY_MAX_CONCURRENCY,
      Math.round(Number(input.concurrency) || numberEnv(
        "KTO_TOURISM_VISITOR_HISTORY_CONCURRENCY",
        VISITOR_HISTORY_DEFAULT_CONCURRENCY,
        env
      ))
    ));
    const requested = requestedVisitorRegions(regionMap, input);
    const hasSelector = Boolean(
      (Array.isArray(input.regionKeys) ? input.regionKeys.length : input.regionKeys)
      || (Array.isArray(input.regionNames) ? input.regionNames.length : input.regionNames)
      || (Array.isArray(input.regions) ? input.regions.length : input.regions)
      || input.regionKey
    );
    const selectedRegions = hasSelector ? requested.selected : (regionMap.regions || []);
    if (hasSelector && !selectedRegions.length) {
      return {
        ok: false,
        status: "region_not_matched",
        reason: "requested_region_not_matched",
        period: { startYearMonth: months[0], endYearMonth, months: monthCount },
        coverage: {
          expectedRegionMonths: 0,
          completeRegionMonths: 0,
          partialRegionMonths: 0,
          missingRegionMonths: 0,
          coverageRate: 0
        },
        regions: [],
        unmatchedRegions: requested.unmatchedNames,
        quality: {
          missingIsNotZero: true,
          partialMonthsExcludedFromMetrics: true,
          coverageRateUnit: "ratio_0_to_1",
          scoreMinimums: { ...VISITOR_OUTLOOK_SCORE_MINIMUMS }
        }
      };
    }

    const monthResults = new Array(months.length);
    let cursor = 0;
    async function worker() {
      while (cursor < months.length) {
        const index = cursor;
        cursor += 1;
        monthResults[index] = await visitorMonthForHistory(months[index], regionMap, {
          collectMissing,
          retryIncomplete,
          regionKeys: hasSelector ? selectedRegions.map((region) => region.regionKey) : [],
          force,
          ttlHours
        });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, months.length) }, () => worker()));

    const latestMonthSnapshot = monthResults.at(-1)?.snapshot || {};
    const regions = selectedRegions.map((region) => {
      const series = monthResults.map((monthResult) => visitorHistoryPoint(monthResult, region));
      const recentSeries = series.slice(-VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths);
      const previousSeries = series.slice(
        -(VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths + VISITOR_OUTLOOK_SCORE_MINIMUMS.previousWindowMonths),
        -VISITOR_OUTLOOK_SCORE_MINIMUMS.recentWindowMonths
      );
      const coverage = {
        ...coverageWindow(series),
        recent12: coverageWindow(recentSeries),
        previous12: coverageWindow(previousSeries)
      };
      const latest = series.at(-1) || null;
      const latestAvailable = [...series].reverse().find((point) => point.status === "complete") || null;
      const yoy = visitorSameMonthComparison(series, endYearMonth);
      const recent12VsPrevious12 = visitorGrowthComparison(recentSeries, previousSeries);
      return {
        regionKey: region.regionKey,
        sido: region.sido,
        sigungu: region.sigungu,
        series,
        coverage,
        latest,
        latestAvailable,
        yoy,
        recent12VsPrevious12,
        visitorOutlookScore: visitorOutlook(series, coverage, latestMonthSnapshot, endYearMonth)
      };
    });

    const allPoints = regions.flatMap((region) => region.series);
    const completeRegionMonths = allPoints.filter((point) => point.status === "complete").length;
    const partialRegionMonths = allPoints.filter((point) => point.status === "partial").length;
    const expectedRegionMonths = allPoints.length;
    const missingRegionMonths = expectedRegionMonths - completeRegionMonths - partialRegionMonths;
    const cacheHitMonths = monthResults.filter((result) => result.access === "cache").length;
    const networkResults = monthResults.filter((result) => result.access === "network");
    const networkSucceededMonths = networkResults.filter((result) => result.networkSucceeded).length;
    const available = completeRegionMonths > 0;
    const fullyComplete = expectedRegionMonths > 0 && completeRegionMonths === expectedRegionMonths;
    return {
      ok: available,
      status: fullyComplete ? "ok" : available ? "partial" : "unavailable",
      reason: fullyComplete ? "" : available ? "incomplete_history_coverage" : "no_complete_history_observation",
      schemaVersion: 1,
      adapter: VISITOR_ADAPTER_VERSION,
      collectedAt: currentDate().toISOString(),
      period: {
        startYearMonth: months[0],
        endYearMonth,
        months: monthCount,
        latestClosedYearMonth: closedYearMonth
      },
      collection: {
        mode: force ? "force_refresh" : collectMissing ? "backfill_missing" : "cache_only",
        concurrency,
        requestedMonths: months.length,
        cacheHitMonths,
        missingCacheMonths: monthResults.filter((result) => result.access === "missing").length,
        networkAttemptedMonths: networkResults.length,
        networkSucceededMonths,
        networkFailedMonths: networkResults.length - networkSucceededMonths,
        retriedIncompleteMonths: networkResults.filter((result) => result.retriedIncomplete).length,
        refreshErrors: networkResults
          .filter((result) => !result.networkSucceeded)
          .map((result) => ({ yearMonth: result.yearMonth, reason: result.refreshError || result.snapshot?.reason || "collection_failed" }))
      },
      coverage: {
        expectedRegionMonths,
        completeRegionMonths,
        partialRegionMonths,
        missingRegionMonths,
        coverageRate: expectedRegionMonths ? roundNumber(completeRegionMonths / expectedRegionMonths, 4) : 0
      },
      regions,
      unmatchedRegions: requested.unmatchedNames,
      source: {
        key: "visitors",
        label: "한국관광공사 지역별 방문자수",
        referenceUrl: DEFAULT_SOURCE_DEFS[0].referenceUrl,
        metric: "완전월 일평균 순방문자"
      },
      quality: {
        missingIsNotZero: true,
        partialMonthsExcludedFromMetrics: true,
        failedRefreshDoesNotOverwriteCompleteCache: true,
        retryIncompleteOnBackfill: retryIncomplete,
        coverageRateUnit: "ratio_0_to_1",
        scoreMinimums: { ...VISITOR_OUTLOOK_SCORE_MINIMUMS },
        scoreComponents: [
          { key: "latest_peer_percentile", weight: 0.4 },
          { key: "recent12_vs_previous12", weight: 0.35, normalization: "-25%..+25%=0..100" },
          { key: "latest_same_month_yoy", weight: 0.25, normalization: "-25%..+25%=0..100" }
        ]
      }
    };
  }

  async function collect(input = {}) {
    const yearMonth = normalizeYearMonth(input.yearMonth || input.period || input.baseYm);
    const sources = selectedSources(input.sources);
    const ttlHours = Number.isFinite(Number(input.ttlHours)) ? Number(input.ttlHours) : DEFAULT_TTL_HOURS;
    const force = Boolean(input.force);
    const allowUnverifiedCodes = Boolean(input.allowUnverifiedCodes) || boolEnv("KTO_TOURISM_ALLOW_UNVERIFIED_CODES", false, env);
    const match = await resolveRegion(input);

    if (!match.region) {
      return {
        ok: false,
        status: "region_not_matched",
        confidence: match.confidence,
        yearMonth,
        sources: {},
        error: "Region could not be matched to tourism_region_map.json"
      };
    }

    const cacheInput = { region: match.region, yearMonth, sources };
    const cached = await readCache(cacheInput);
    if (!force && cached.hit && cacheFresh(cached.data, ttlHours)) {
      return { ...cached.data, ok: true, cache: { hit: true, filePath: cached.filePath } };
    }

    const commonServiceKey = dataGoKrServiceKey(env);
    const visitorServiceKey = sourceServiceKey(DEFAULT_SOURCE_DEFS[0], env);
    const sourceConfigs = DEFAULT_SOURCE_DEFS
      .map((def) => sourceConfig(def, env))
      .filter((config) => sources.includes(config.key));

    const snapshot = {
      ok: true,
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      yearMonth,
      region: match.region,
      match: {
        confidence: match.confidence,
        reason: match.reason
      },
      cache: {
        hit: false,
        ttlHours
      },
      sourcePolicy: {
        serviceKeyConfigured: Boolean(visitorServiceKey || commonServiceKey),
        visitorServiceKeyConfigured: Boolean(visitorServiceKey),
        commonServiceKeyConfigured: Boolean(commonServiceKey),
        allowUnverifiedCodes,
        noSidoSigunguAggregation: true
      },
      sources: {}
    };

    if (match.region.codeStatus && !allowUnverifiedCodes) {
      for (const config of sourceConfigs) {
        snapshot.sources[config.key] = {
          label: config.label,
          referenceUrl: config.referenceUrl,
          status: "skipped",
          reason: "region_code_verify_required",
          rows: []
        };
      }
      await writeSnapshot(snapshot);
      return snapshot;
    }

    for (const config of sourceConfigs) {
      if (config.key === "visitors") {
        const visitorSnapshot = await collectVisitorCounts({
          yearMonth,
          regionKeys: [match.region.regionKey],
          force,
          ttlHours
        });
        snapshot.sources[config.key] = {
          label: config.label,
          referenceUrl: config.referenceUrl,
          configStatus: visitorEndpointStatus(config, sourceServiceKey(config, env)),
          status: visitorSnapshot.status === "ok" ? "ok" : visitorSnapshot.status === "unavailable" ? "skipped" : visitorSnapshot.status,
          reason: visitorSnapshot.reason || "",
          rows: visitorSnapshot.regions || [],
          requestedAt: visitorSnapshot.collectedAt || new Date().toISOString()
        };
        continue;
      }
      snapshot.sources[config.key] = {
        label: config.label,
        referenceUrl: config.referenceUrl,
        configStatus: sourceStatus(config, sourceServiceKey(config, env)),
        regionParam: config.regionParam,
        periodParam: config.periodParam,
        ...(await requestSource(config, match.region, yearMonth))
      };
    }

    await writeSnapshot(snapshot);
    return snapshot;
  }

  async function status() {
    let regionMap = null;
    try {
      regionMap = await readRegionMap();
    } catch (error) {
      regionMap = { error: error.message, regions: [] };
    }

    let cacheFiles = [];
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      cacheFiles = (await fsp.readdir(cacheDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch {
      cacheFiles = [];
    }

    const commonServiceKey = dataGoKrServiceKey(env);
    const configuredSourceKeys = DEFAULT_SOURCE_DEFS
      .map((def) => sourceServiceKey(def, env))
      .filter(Boolean);
    const visitorHistoryMonthsAvailable = cacheFiles
      .map((fileName) => fileName.match(new RegExp(`^visitors__${VISITOR_ADAPTER_VERSION}__.+__(\\d{6})\\.json$`))?.[1] || "")
      .filter(Boolean)
      .sort();
    return {
      ok: true,
      enabled: true,
      dataDir: tourismDataDir,
      cacheCount: cacheFiles.length,
      regionMap: {
        version: regionMap.version || "",
        regionCount: regionMap.regions?.length || 0,
        error: regionMap.error || ""
      },
      serviceKeyConfigured: Boolean(configuredSourceKeys.length),
      commonServiceKeyConfigured: Boolean(commonServiceKey),
      visitorHistory: {
        availableMonthCount: visitorHistoryMonthsAvailable.length,
        earliestYearMonth: visitorHistoryMonthsAvailable[0] || "",
        latestYearMonth: visitorHistoryMonthsAvailable.at(-1) || ""
      },
      sources: DEFAULT_SOURCE_DEFS.map((def) => {
        const config = sourceConfig(def, env);
        const serviceKey = sourceServiceKey(config, env);
        return {
          key: config.key,
          label: config.label,
          referenceUrl: config.referenceUrl,
          status: def.key === "visitors" ? visitorEndpointStatus(config, serviceKey) : sourceStatus(config, serviceKey),
          serviceKeyConfigured: Boolean(serviceKey),
          serviceKeyEnvironment: config.serviceKeyEnv || "DATA_GO_KR_SERVICE_KEY",
          endpointConfigured: Boolean(config.endpoint),
          regionParam: config.regionParam,
          periodParam: config.periodParam
        };
      })
    };
  }

  return {
    collect,
    collectVisitorCounts,
    collectVisitorHistory,
    resolveRegion,
    status,
    readRegionMap
  };
}

module.exports = {
  createCollector,
  DEFAULT_SOURCE_DEFS,
  dataGoKrServiceKey,
  sourceServiceKey,
  normalizeYearMonth,
  latestClosedYearMonth,
  monthDateRange,
  shiftYearMonth,
  visitorHistoryMonths,
  VISITOR_ADAPTER_VERSION,
  VISITOR_OUTLOOK_MODEL_VERSION,
  VISITOR_OUTLOOK_SCORE_MINIMUMS
};
