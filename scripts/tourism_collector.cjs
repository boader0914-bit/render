const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const {
  buildObservation,
  CONTRACT_VERSIONS,
  fingerprintRequest
} = require("./location_insight_contract.cjs");
const {
  matchLocationRegion,
  seoulCalendarDate,
  validateLocationRegionRegistry
} = require("./location_region_matcher.cjs");

const DEFAULT_SOURCE_DEFS = [
  {
    key: "visitors",
    contractSourceKey: "kto.visitors",
    label: "regional visitors",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15101972",
    envPrefix: "KTO_TOURISM_VISITOR",
    referenceUrl: "https://www.data.go.kr/data/15101972/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "YM"
  },
  {
    key: "resourceDemand",
    contractSourceKey: "kto.resource_demand",
    label: "tourism resource demand",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15152138",
    envPrefix: "KTO_TOURISM_RESOURCE_DEMAND",
    referenceUrl: "https://www.data.go.kr/data/15152138/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "BASE_YM"
  },
  {
    key: "diversity",
    contractSourceKey: "kto.diversity",
    label: "tourism diversity",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15151365",
    envPrefix: "KTO_TOURISM_DIVERSITY",
    referenceUrl: "https://www.data.go.kr/data/15151365/openapi.do",
    defaultRegionParam: "SGG_CD",
    defaultPeriodParam: "BASE_YM"
  }
];

const DEFAULT_MOBILE_APP = "lodging-datalab";
const DEFAULT_TTL_HOURS = 24 * 7;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TOURISM_SNAPSHOT_SCHEMA_VERSION = 2;
const TOURISM_CONTRACT_VERSION = CONTRACT_VERSIONS.observation;
const OBSERVATION_QUALITY_ORDER = ["ready", "zero", "missing", "partial", "stale", "conflict"];

function compactText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
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

function normalizeYearMonth(value = "", now = new Date()) {
  const raw = String(value || "").trim();
  if (!raw) return latestClosedYearMonth(now);
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  const month = Number(digits.slice(4, 6));
  if (digits.length !== 6 || month < 1 || month > 12) {
    const error = new RangeError("yearMonth must identify a valid calendar month");
    error.code = "INVALID_YEAR_MONTH";
    error.statusCode = 400;
    throw error;
  }
  return digits;
}

function yearMonthRange(value) {
  const yearMonth = normalizeYearMonth(value);
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}-01`,
    to: `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}-${String(lastDay).padStart(2, "0")}`
  };
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
    env.KTO_TOURISM_SERVICE_KEY ||
    env.KTO_DATA_GO_KR_SERVICE_KEY ||
    env.DATA_GO_KR_SERVICE_KEY ||
    ""
  ).trim();
}

function sourceConfig(def, env = process.env) {
  const prefix = def.envPrefix;
  return {
    ...def,
    endpoint: String(env[`${prefix}_ENDPOINT`] || "").trim(),
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
    timeoutMs: numberEnv(`${prefix}_TIMEOUT_MS`, numberEnv("KTO_TOURISM_TIMEOUT_MS", 15000, env), env),
    maxResponseBytes: Math.max(1024, numberEnv(`${prefix}_MAX_RESPONSE_BYTES`, numberEnv("KTO_TOURISM_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES, env), env))
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
  const regionRegistryFile = options.regionRegistryFile || path.join(webDir, "data", "location_region_registry.json");
  const env = options.env || process.env;
  const fetchImpl = typeof options.fetch === "function"
    ? options.fetch
    : typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => new Date();

  async function readRegionMap() {
    const raw = await fsp.readFile(regionMapFile, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return {
      ...parsed,
      regions: Array.isArray(parsed.regions) ? parsed.regions : [],
      provinceAliases: parsed.provinceAliases || {}
    };
  }

  async function readRegionRegistry() {
    const raw = await fsp.readFile(regionRegistryFile, "utf8");
    return validateLocationRegionRegistry(JSON.parse(raw.replace(/^\uFEFF/, "")));
  }

  async function resolveRegion(input = {}) {
    const [regionMap, regionRegistry] = await Promise.all([readRegionMap(), readRegionRegistry()]);
    const strictMatch = matchLocationRegion({
      ...input,
      asOf: input.asOf || seoulCalendarDate(now())
    }, regionRegistry);
    return {
      ...strictMatch,
      regionMap,
      registryVersion: regionRegistry.registryVersion
    };
  }

  function cacheKey({ region = {}, yearMonth = "", sources = [] } = {}) {
    return [
      `schema${TOURISM_SNAPSHOT_SCHEMA_VERSION}`,
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
    return now().getTime() - collectedAt < ttlHours * 60 * 60 * 1000;
  }

  async function writeSnapshot(snapshot = {}) {
    await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(tourismDataDir, { recursive: true, mode: 0o700 });
    const filePath = cachePath(snapshot);
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tempPath, filePath);
    await fsp.appendFile(logFile, `${JSON.stringify({
      collectedAt: snapshot.collectedAt,
      regionKey: snapshot.region?.regionKey || "",
      yearMonth: snapshot.yearMonth || "",
      sourceCount: Object.keys(snapshot.sources || {}).length,
      cacheKey: cacheKey(snapshot)
    })}\n`, { encoding: "utf8", mode: 0o600 });
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
    const requestedAt = now().toISOString();
    if (status !== "ready") {
      return { status: "skipped", reason: status, requestedAt, completedAt: requestedAt, rows: [], raw: null };
    }

    const url = buildUrl(config, region, yearMonth);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      if (typeof fetchImpl !== "function") throw new Error("fetch implementation is not available");
      const response = await fetchImpl(url, { signal: controller.signal });
      const text = await response.text();
      const responseBytes = Buffer.byteLength(text || "", "utf8");
      const rawPayloadHash = crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
      if (responseBytes > config.maxResponseBytes) {
        return {
          status: "error",
          reason: "response_too_large",
          httpStatus: response.status,
          requestedAt,
          completedAt: now().toISOString(),
          endpointConfigured: true,
          responseBytes,
          rawPayloadHash,
          rows: []
        };
      }
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { rawText: text };
      }
      const rows = normalizeApiRows(parsed);
      const responseMeta = normalizeApiResponseMeta(parsed, rows);
      const apiSuccess = response.ok && responseMeta.apiSuccess;
      return {
        status: apiSuccess ? "ok" : "error",
        reason: response.ok && !responseMeta.apiSuccess ? "upstream_result_error" : "",
        httpStatus: response.status,
        requestedAt,
        completedAt: now().toISOString(),
        endpointConfigured: true,
        responseBytes,
        rows,
        responseMeta,
        rawPayloadHash,
        ...(options.includeRaw === true ? { raw: parsed } : {})
      };
    } catch (error) {
      return {
        status: "error",
        reason: error.name === "AbortError" ? "timeout" : "request_failed",
        message: error.message || String(error),
        requestedAt,
        completedAt: now().toISOString(),
        rows: [],
        raw: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeApiRows(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    const candidates = [
      parsed?.response?.body?.items?.item,
      parsed?.body?.items?.item,
      parsed?.items?.item,
      Array.isArray(parsed?.response?.body?.items) ? parsed.response.body.items : null,
      Array.isArray(parsed?.body?.items) ? parsed.body.items : null,
      Array.isArray(parsed?.items) ? parsed.items : null,
      parsed?.data
    ];
    const found = candidates.find((candidate) => Array.isArray(candidate) || (candidate && typeof candidate === "object"));
    if (!found) return [];
    if (Array.isArray(found)) return found;
    if (Array.isArray(found.item)) return found.item;
    return [found];
  }

  function normalizeApiResponseMeta(parsed, rows = []) {
    const body = parsed?.response?.body || parsed?.body || {};
    const header = parsed?.response?.header || parsed?.header || {};
    const nonNegativeInteger = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 ? number : null;
    };
    const totalCount = nonNegativeInteger(body.totalCount ?? parsed?.totalCount);
    const pageNo = nonNegativeInteger(body.pageNo ?? parsed?.pageNo);
    const numOfRows = nonNegativeInteger(body.numOfRows ?? parsed?.numOfRows);
    const returnedRowCount = Array.isArray(rows) ? rows.length : 0;
    const uniqueRowCount = new Set((Array.isArray(rows) ? rows : []).map((row) => {
      try {
        return JSON.stringify(row);
      } catch {
        return String(row);
      }
    })).size;
    const pageCount = totalCount !== null && numOfRows
      ? Math.ceil(totalCount / numOfRows)
      : null;
    const complete = totalCount !== null && (pageNo === null || pageNo === 1) && uniqueRowCount >= totalCount;
    const resultCode = String(header.resultCode ?? parsed?.resultCode ?? "").slice(0, 80);
    const apiSuccess = !resultCode || ["0", "00", "0000", "NORMAL_SERVICE"].includes(resultCode.toUpperCase());
    return {
      resultCode,
      resultMessage: String(header.resultMsg ?? header.resultMessage ?? parsed?.resultMsg ?? "").slice(0, 240),
      apiSuccess,
      totalCount,
      pageNo,
      numOfRows,
      pageCount,
      pagesExpected: pageCount,
      pagesFetched: 1,
      returnedRowCount,
      uniqueRowCount,
      coverageRatio: totalCount === null
        ? null
        : totalCount === 0
          ? 1
          : Number(Math.min(1, uniqueRowCount / totalCount).toFixed(4)),
      complete,
      paginationComplete: complete,
      explicitZero: totalCount === 0,
      terminationReason: totalCount === null
        ? "total_count_unavailable"
        : complete
          ? "complete"
          : "single_page_incomplete"
    };
  }

  function collectionQuality(result = {}) {
    const meta = result.responseMeta || {};
    if (result.status !== "ok") {
      return {
        status: "missing",
        confidenceGrade: "D",
        confidenceScore: 0,
        penaltyReasons: [result.reason || "collection_failed"]
      };
    }
    if (
      (meta.totalCount !== null && meta.returnedRowCount > meta.totalCount)
      || (meta.numOfRows !== null && meta.returnedRowCount > meta.numOfRows)
    ) {
      return {
        status: "conflict",
        confidenceGrade: "D",
        confidenceScore: 20,
        penaltyReasons: ["pagination_count_conflict"]
      };
    }
    if (meta.explicitZero) {
      return {
        status: "zero",
        confidenceGrade: "A",
        confidenceScore: 100,
        penaltyReasons: []
      };
    }
    if (meta.totalCount === null) {
      return {
        status: "partial",
        confidenceGrade: "C",
        confidenceScore: 50,
        penaltyReasons: ["coverage_denominator_missing"]
      };
    }
    if (!meta.complete) {
      return {
        status: "partial",
        confidenceGrade: "C",
        confidenceScore: meta.coverageRatio === null ? 50 : Math.round(40 + meta.coverageRatio * 40),
        penaltyReasons: ["pagination_incomplete"]
      };
    }
    if (!meta.returnedRowCount) {
      return {
        status: "missing",
        confidenceGrade: "D",
        confidenceScore: 0,
        penaltyReasons: ["empty_without_explicit_zero"]
      };
    }
    return {
      status: "ready",
      confidenceGrade: "A",
      confidenceScore: 100,
      penaltyReasons: []
    };
  }

  function collectionGeo(region = {}) {
    const ktoSggCd = String(region.ktoSggCd || "");
    if (/^\d{5}$/.test(ktoSggCd)) {
      return {
        codeSystem: "KTO_DATALAB_SGG_CD",
        code: ktoSggCd,
        level: region.unit || "sigungu",
        name: region.sigungu || region.regionKey || ""
      };
    }
    return {
      codeSystem: "LODGING_DATALAB_REGION_KEY_V1",
      code: String(region.regionKey || ""),
      level: region.unit || "sigungu",
      name: region.sigungu || region.regionKey || ""
    };
  }

  function buildCollectionObservation(config, region, yearMonth, result = {}, quality = collectionQuality(result)) {
    const period = yearMonthRange(yearMonth);
    const responseMeta = result.responseMeta || {};
    const fetchedAt = result.completedAt || result.requestedAt || now().toISOString();
    const observedRowCount = Number(responseMeta.uniqueRowCount ?? responseMeta.returnedRowCount ?? result.rows?.length ?? 0);
    const value = quality.status === "missing" ? null : observedRowCount;
    return buildObservation({
      observationType: "collection_coverage",
      sourceKey: config.contractSourceKey,
      sourceUrl: config.referenceUrl,
      metricKey: "collection.rows_received",
      value,
      unit: "row",
      normalization: {
        method: "source_envelope_row_count",
        version: "tourism-collector-v2",
        parameters: { businessMetric: false }
      },
      geo: collectionGeo(region),
      observedFrom: period.from,
      observedTo: period.to,
      fetchedAt,
      sample: {
        n: observedRowCount,
        populationN: responseMeta.totalCount ?? null,
        unit: "row"
      },
      coverage: {
        numerator: responseMeta.uniqueRowCount ?? responseMeta.returnedRowCount ?? null,
        denominator: responseMeta.totalCount ?? null,
        ratio: responseMeta.totalCount === 0
          ? 1
          : responseMeta.totalCount > 0
            ? observedRowCount / responseMeta.totalCount
            : null,
        note: responseMeta.totalCount === null ? "coverage denominator unavailable" : "single-request page coverage"
      },
      status: quality.status,
      confidence: {
        grade: quality.confidenceGrade,
        score: quality.confidenceScore,
        penalties: quality.penaltyReasons
      },
      requestFingerprint: fingerprintRequest({
        sourceKey: config.contractSourceKey,
        regionCode: region.ktoSggCd || "",
        period: yearMonth,
        pageNo: config.extraParams?.pageNo || "1",
        numOfRows: config.extraParams?.numOfRows || "100"
      }),
      rawPayloadHash: result.rawPayloadHash || "",
      licenseSnapshot: {
        capturedAt: fetchedAt
      }
    });
  }

  function summarizeSnapshotQuality(sources = {}) {
    const statuses = Object.values(sources).map((source) => source?.quality?.status).filter(Boolean);
    const counts = Object.fromEntries(OBSERVATION_QUALITY_ORDER.map((status) => [
      status,
      statuses.filter((value) => value === status).length
    ]));
    let status = "missing";
    if (counts.conflict) status = "conflict";
    else if (counts.stale) status = "stale";
    else if (counts.partial || (counts.missing && counts.missing < statuses.length)) status = "partial";
    else if (statuses.length && counts.missing === statuses.length) status = "missing";
    else if (statuses.length && counts.zero === statuses.length) status = "zero";
    else if (statuses.length) status = "ready";
    return { status, sourceCount: statuses.length, counts };
  }

  async function collect(input = {}) {
    const yearMonth = normalizeYearMonth(input.yearMonth || input.period || input.baseYm, now());
    const sources = selectedSources(input.sources);
    const ttlHours = Number.isFinite(Number(input.ttlHours)) ? Number(input.ttlHours) : DEFAULT_TTL_HOURS;
    const force = Boolean(input.force);
    const allowUnverifiedCodes = Boolean(input.allowUnverifiedCodes) || boolEnv("KTO_TOURISM_ALLOW_UNVERIFIED_CODES", false, env);
    const match = await resolveRegion(input);

    if (!match.region) {
      return {
        ok: false,
        status: "region_not_matched",
        matchStatus: match.status,
        confidence: match.confidence,
        reason: match.reason,
        candidates: match.candidates || [],
        registryVersion: match.registryVersion || "",
        yearMonth,
        sources: {},
        error: "Region could not be matched exactly to location_region_registry.json"
      };
    }

    const cacheInput = { region: match.region, yearMonth, sources };
    const cached = await readCache(cacheInput);
    if (!force && cached.hit && cacheFresh(cached.data, ttlHours)) {
      return { ...cached.data, ok: true, cache: { hit: true, filePath: cached.filePath } };
    }

    const serviceKey = dataGoKrServiceKey(env);
    const sourceConfigs = DEFAULT_SOURCE_DEFS
      .map((definition) => sourceConfig(definition, env))
      .filter((config) => sources.includes(config.key));

    const snapshot = {
      ok: true,
      documentType: "tourism-collection-snapshot",
      schemaVersion: TOURISM_SNAPSHOT_SCHEMA_VERSION,
      contractVersion: TOURISM_CONTRACT_VERSION,
      collectedAt: now().toISOString(),
      yearMonth,
      region: match.region,
      match: {
        status: match.status,
        confidence: match.confidence,
        reason: match.reason,
        matchType: match.matchType,
        registryVersion: match.registryVersion || ""
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

    const regionCodeMissing = !/^\d{5}$/.test(String(match.region.ktoSggCd || ""));
    if (regionCodeMissing || (match.region.codeStatus && !allowUnverifiedCodes)) {
      for (const config of sourceConfigs) {
        const result = {
          status: "skipped",
          reason: regionCodeMissing ? "region_code_missing" : "region_code_verify_required",
          requestedAt: snapshot.collectedAt,
          completedAt: snapshot.collectedAt,
          rows: []
        };
        const quality = collectionQuality(result);
        snapshot.sources[config.key] = {
          sourceKey: config.contractSourceKey,
          label: config.label,
          provider: config.provider,
          datasetId: config.datasetId,
          referenceUrl: config.referenceUrl,
          ...result,
          quality,
          collectionObservation: buildCollectionObservation(config, match.region, yearMonth, result, quality)
        };
      }
      snapshot.quality = summarizeSnapshotQuality(snapshot.sources);
      snapshot.status = snapshot.quality.status;
      await writeSnapshot(snapshot);
      return snapshot;
    }

    for (const config of sourceConfigs) {
      const result = await requestSource(config, match.region, yearMonth);
      const quality = collectionQuality(result);
      snapshot.sources[config.key] = {
        sourceKey: config.contractSourceKey,
        label: config.label,
        provider: config.provider,
        datasetId: config.datasetId,
        referenceUrl: config.referenceUrl,
        configStatus: sourceStatus(config, serviceKey),
        regionParam: config.regionParam,
        periodParam: config.periodParam,
        period: {
          type: "calendar_month",
          value: yearMonth
        },
        geo: {
          ...collectionGeo(match.region),
          regionKey: match.region.regionKey || ""
        },
        ...result,
        quality,
        collectionObservation: buildCollectionObservation(config, match.region, yearMonth, result, quality)
      };
    }

    snapshot.quality = summarizeSnapshotQuality(snapshot.sources);
    snapshot.status = snapshot.quality.status;

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

    let regionRegistry = null;
    try {
      regionRegistry = await readRegionRegistry();
    } catch (error) {
      regionRegistry = { error: error.message, regions: [] };
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

    const serviceKey = dataGoKrServiceKey(env);
    return {
      ok: true,
      documentType: "tourism-collector-status",
      schemaVersion: TOURISM_SNAPSHOT_SCHEMA_VERSION,
      contractVersion: TOURISM_CONTRACT_VERSION,
      enabled: true,
      dataDir: tourismDataDir,
      cacheCount: cacheFiles.length,
      regionMap: {
        version: regionMap.version || "",
        regionCount: regionMap.regions?.length || 0,
        error: regionMap.error || ""
      },
      regionRegistry: {
        version: regionRegistry.registryVersion || "",
        regionCount: regionRegistry.regions?.length || 0,
        effectiveFrom: regionRegistry.effectiveFrom || "",
        effectiveTo: regionRegistry.effectiveTo || null,
        error: regionRegistry.error || ""
      },
      serviceKeyConfigured: Boolean(serviceKey),
      sources: DEFAULT_SOURCE_DEFS.map((def) => {
        const config = sourceConfig(def, env);
        return {
          key: config.key,
          sourceKey: config.contractSourceKey,
          label: config.label,
          provider: config.provider,
          datasetId: config.datasetId,
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
    readRegionMap,
    readRegionRegistry
  };
}

module.exports = {
  createCollector,
  DEFAULT_SOURCE_DEFS,
  normalizeYearMonth,
  latestClosedYearMonth
};
