const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SOURCE_DEFS = [
  {
    key: "visitors",
    label: "regional visitors",
    envPrefix: "KTO_TOURISM_VISITOR",
    referenceUrl: "https://www.data.go.kr/data/15101972/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "YM"
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

function compactText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
}

function stripBusinessWords(value = "") {
  return compactText(value)
    .replace(/글램핑|캠핑장|캠핑|카라반|펜션|풀빌라|숙소|호텔|리조트|모텔|야영장|오토캠핑|스테이|빌리지/g, "")
    .replace(/특별자치도|특별자치시|광역시|특별시|자치시|자치도|시|군|구|도$/g, "");
}

function safeName(value = "") {
  return compactText(value).slice(0, 80) || "unknown";
}

function parseJsonEnv(name, fallback = {}) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
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
  if (digits.length >= 6) return digits.slice(0, 6);
  return latestClosedYearMonth();
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

function dataGoKrServiceKey() {
  return String(
    process.env.KTO_TOURISM_SERVICE_KEY ||
    process.env.KTO_DATA_GO_KR_SERVICE_KEY ||
    process.env.DATA_GO_KR_SERVICE_KEY ||
    ""
  ).trim();
}

function sourceConfig(def) {
  const prefix = def.envPrefix;
  return {
    ...def,
    endpoint: String(process.env[`${prefix}_ENDPOINT`] || "").trim(),
    enabled: !/^(0|false|off)$/i.test(String(process.env[`${prefix}_ENABLED`] || "1").trim()),
    regionParam: String(process.env[`${prefix}_REGION_PARAM`] || def.defaultRegionParam).trim(),
    periodParam: String(process.env[`${prefix}_PERIOD_PARAM`] || def.defaultPeriodParam).trim(),
    serviceKeyParam: String(process.env[`${prefix}_SERVICE_KEY_PARAM`] || process.env.KTO_TOURISM_SERVICE_KEY_PARAM || "serviceKey").trim(),
    extraParams: {
      _type: "json",
      MobileOS: "ETC",
      MobileApp: String(process.env.KTO_TOURISM_MOBILE_APP || DEFAULT_MOBILE_APP).trim(),
      pageNo: "1",
      numOfRows: "100",
      ...parseJsonEnv(`${prefix}_PARAMS`, {}),
      ...parseJsonEnv("KTO_TOURISM_COMMON_PARAMS", {})
    },
    timeoutMs: numberEnv(`${prefix}_TIMEOUT_MS`, numberEnv("KTO_TOURISM_TIMEOUT_MS", 15000))
  };
}

function sourceStatus(config, serviceKey) {
  if (!config.enabled) return "disabled";
  if (!serviceKey) return "missing_service_key";
  if (!config.endpoint) return "missing_endpoint";
  return "ready";
}

function createCollector(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const webDir = options.webDir || path.join(rootDir, "web");
  const dataDir = options.dataDir || rootDir;
  const tourismDataDir = options.tourismDataDir || path.join(dataDir, "tourism_data");
  const cacheDir = path.join(tourismDataDir, "cache");
  const logFile = path.join(tourismDataDir, "collections.jsonl");
  const regionMapFile = options.regionMapFile || path.join(webDir, "data", "tourism_region_map.json");

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
    return Date.now() - collectedAt < ttlHours * 60 * 60 * 1000;
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

    const serviceKey = dataGoKrServiceKey();
    if (serviceKey) {
      const connector = url.toString().includes("?") ? "&" : "?";
      const keyValue = serviceKey.includes("%") ? serviceKey : encodeURIComponent(serviceKey);
      return `${url.toString()}${connector}${encodeURIComponent(config.serviceKeyParam)}=${keyValue}`;
    }
    return url.toString();
  }

  async function requestSource(config, region, yearMonth) {
    const status = sourceStatus(config, dataGoKrServiceKey());
    const requestedAt = new Date().toISOString();
    if (status !== "ready") {
      return { status: "skipped", reason: status, requestedAt, rows: [], raw: null };
    }

    const url = buildUrl(config, region, yearMonth);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
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

  async function collect(input = {}) {
    const yearMonth = normalizeYearMonth(input.yearMonth || input.period || input.baseYm);
    const sources = selectedSources(input.sources);
    const ttlHours = Number.isFinite(Number(input.ttlHours)) ? Number(input.ttlHours) : DEFAULT_TTL_HOURS;
    const force = Boolean(input.force);
    const allowUnverifiedCodes = Boolean(input.allowUnverifiedCodes) || boolEnv("KTO_TOURISM_ALLOW_UNVERIFIED_CODES", false);
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

    const serviceKey = dataGoKrServiceKey();
    const sourceConfigs = DEFAULT_SOURCE_DEFS
      .map(sourceConfig)
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
        serviceKeyConfigured: Boolean(serviceKey),
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
      snapshot.sources[config.key] = {
        label: config.label,
        referenceUrl: config.referenceUrl,
        configStatus: sourceStatus(config, serviceKey),
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

    const serviceKey = dataGoKrServiceKey();
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
      serviceKeyConfigured: Boolean(serviceKey),
      sources: DEFAULT_SOURCE_DEFS.map((def) => {
        const config = sourceConfig(def);
        return {
          key: config.key,
          label: config.label,
          referenceUrl: config.referenceUrl,
          status: sourceStatus(config, serviceKey),
          endpointConfigured: Boolean(config.endpoint),
          regionParam: config.regionParam,
          periodParam: config.periodParam
        };
      })
    };
  }

  return {
    collect,
    resolveRegion,
    status,
    readRegionMap
  };
}

module.exports = {
  createCollector,
  DEFAULT_SOURCE_DEFS,
  normalizeYearMonth,
  latestClosedYearMonth
};
