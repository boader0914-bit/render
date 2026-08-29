const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA_FILE = path.join(ROOT, "schemas", "master_db_v1.sql");
const SCHEMA_VERSION = "master-db-v1";

const STATUS_RANKS = Object.freeze({
  rejected: 0,
  error: 10,
  no_data: 20,
  not_supported: 20,
  pending: 30,
  stale: 40,
  partial: 60,
  complete: 100
});

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizeKey(value) {
  return cleanText(value).toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeStatus(value) {
  const key = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["ok", "success", "normal", "observed"].includes(key)) return "complete";
  if (["no_observation", "missing", "empty"].includes(key)) return "no_data";
  if (["failed", "failure", "blocked"].includes(key)) return "error";
  return Object.hasOwn(STATUS_RANKS, key) ? key : "pending";
}

function statusRank(value) {
  return STATUS_RANKS[normalizeStatus(value)];
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

function stableId(prefix, ...parts) {
  const input = parts.map((part) => cleanText(part)).join("\u001f");
  return `${prefix}_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function numberOrNull(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value).replace(/,/g, "");
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cleanText(value);
  if (!text) return null;
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!matches || matches.length !== 1) return null;
  const parsed = Number(matches[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function getDatabaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch (error) {
    const wrapped = new Error(
      "마스터 DB 작업에는 node:sqlite를 기본 지원하는 Node.js 22.13 이상이 필요합니다. 현재 앱 실행에는 영향을 주지 않으며, 마스터 DB 명령만 중단되었습니다."
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function openMasterDatabase(databasePath) {
  const DatabaseSync = getDatabaseSync();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  return database;
}

function applySchema(database, options = {}) {
  const schemaFile = options.schemaFile || SCHEMA_FILE;
  const schema = fs.readFileSync(schemaFile, "utf8");
  const checksum = sha256Buffer(Buffer.from(schema));
  const migrationTableExists = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (migrationTableExists) {
    const existing = database.prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?").get(SCHEMA_VERSION);
    if (existing && existing.checksum !== checksum) {
      const error = new Error(
        `기존 ${SCHEMA_VERSION} DB의 스키마 checksum이 다릅니다. 기존 DB를 변경한 것으로 표시하지 않고 중단합니다. 새 버전 migration이 필요합니다.`
      );
      error.code = "master_db_schema_checksum_mismatch";
      throw error;
    }
  }
  database.exec(schema);
  database.prepare(`
    INSERT INTO schema_migrations (version, checksum, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(SCHEMA_VERSION, checksum, nowIso());
  database.prepare(`
    INSERT INTO master_meta (meta_key, meta_value, updated_at)
    VALUES ('schema_version', ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET
      meta_value = excluded.meta_value,
      updated_at = excluded.updated_at
  `).run(SCHEMA_VERSION, nowIso());
  return { version: SCHEMA_VERSION, checksum };
}

function withTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function upsertRegionMetric(database, record) {
  let status = normalizeStatus(record.status);
  const hasValue = Number(
    numberOrNull(record.valueNum) !== null
    || Boolean(cleanText(record.valueText))
  );
  if (status === "complete" && !hasValue) status = "no_data";
  const collectedAt = cleanText(record.collectedAt) || nowIso();
  const rawJson = safeJson(record.raw ?? null);
  const contentHash = sha256Buffer(Buffer.from(safeJson({
    runId: record.runId ?? null,
    regionId: record.regionId,
    sourceId: record.sourceId,
    metricCode: record.metricCode,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    valueNum: record.valueNum ?? null,
    valueText: record.valueText ?? null,
    unit: record.unit ?? null,
    status,
    collectedAt,
    sourceArtifactId: record.sourceArtifactId ?? null,
    qualityScore: record.qualityScore ?? null,
    raw: record.raw ?? null
  })));
  const observationId = cleanText(record.observationId) || stableId(
    "rmo",
    record.regionId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    collectedAt,
    contentHash
  );
  const existing = database.prepare("SELECT content_hash FROM region_metric_observations WHERE observation_id = ?").get(observationId);
  if (existing && existing.content_hash !== contentHash) {
    const error = new Error(`같은 지역 관측 ID에 다른 내용이 들어왔습니다: ${observationId}`);
    error.code = "immutable_region_observation_conflict";
    throw error;
  }
  const result = database.prepare(`
    INSERT INTO region_metric_observations (
      observation_id, run_id, region_id, source_id, metric_code, period_start, period_end,
      value_num, value_text, unit, status, status_rank, collected_at,
      source_artifact_id, quality_score, content_hash, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(observation_id) DO NOTHING
  `).run(
    observationId,
    record.runId ?? null,
    record.regionId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    record.valueNum ?? null,
    record.valueText ?? null,
    record.unit ?? null,
    status,
    statusRank(status),
    collectedAt,
    record.sourceArtifactId ?? null,
    record.qualityScore ?? null,
    contentHash,
    rawJson,
    nowIso()
  );
  database.prepare(`
    INSERT INTO region_metric_current (
      region_id, source_id, metric_code, period_start, period_end,
      observation_id, status_rank, has_value, collected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(region_id, source_id, metric_code, period_start, period_end) DO UPDATE SET
      observation_id = excluded.observation_id,
      status_rank = excluded.status_rank,
      has_value = excluded.has_value,
      collected_at = excluded.collected_at,
      updated_at = excluded.updated_at
    WHERE excluded.status_rank > region_metric_current.status_rank
       OR (excluded.status_rank = region_metric_current.status_rank
           AND (
             excluded.has_value > region_metric_current.has_value
             OR (
               excluded.has_value = region_metric_current.has_value
               AND excluded.collected_at >= region_metric_current.collected_at
             )
           ))
  `).run(
    record.regionId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    observationId,
    statusRank(status),
    hasValue,
    collectedAt,
    nowIso()
  );
  return { observationId, inserted: Number(result.changes || 0) > 0, contentHash };
}

function upsertKeywordMetric(database, record) {
  let status = normalizeStatus(record.status);
  const hasValue = Number(
    numberOrNull(record.valueNum) !== null
    || Boolean(cleanText(record.valueText))
  );
  if (status === "complete" && !hasValue) status = "no_data";
  const collectedAt = cleanText(record.collectedAt) || nowIso();
  const rawJson = safeJson(record.raw ?? null);
  const contentHash = sha256Buffer(Buffer.from(safeJson({
    runId: record.runId ?? null,
    keywordId: record.keywordId,
    sourceId: record.sourceId,
    metricCode: record.metricCode,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    valueNum: record.valueNum ?? null,
    valueText: record.valueText ?? null,
    unit: record.unit ?? null,
    status,
    collectedAt,
    sourceArtifactId: record.sourceArtifactId ?? null,
    raw: record.raw ?? null
  })));
  const observationId = cleanText(record.observationId) || stableId(
    "kmo",
    record.keywordId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    collectedAt,
    contentHash
  );
  const existing = database.prepare("SELECT content_hash FROM keyword_metric_observations WHERE observation_id = ?").get(observationId);
  if (existing && existing.content_hash !== contentHash) {
    const error = new Error(`같은 키워드 관측 ID에 다른 내용이 들어왔습니다: ${observationId}`);
    error.code = "immutable_keyword_observation_conflict";
    throw error;
  }
  const result = database.prepare(`
    INSERT INTO keyword_metric_observations (
      observation_id, run_id, keyword_id, source_id, metric_code, period_start, period_end,
      value_num, value_text, unit, status, status_rank, collected_at,
      source_artifact_id, content_hash, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(observation_id) DO NOTHING
  `).run(
    observationId,
    record.runId ?? null,
    record.keywordId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    record.valueNum ?? null,
    record.valueText ?? null,
    record.unit ?? null,
    status,
    statusRank(status),
    collectedAt,
    record.sourceArtifactId ?? null,
    contentHash,
    rawJson,
    nowIso()
  );
  database.prepare(`
    INSERT INTO keyword_metric_current (
      keyword_id, source_id, metric_code, period_start, period_end,
      observation_id, status_rank, has_value, collected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(keyword_id, source_id, metric_code, period_start, period_end) DO UPDATE SET
      observation_id = excluded.observation_id,
      status_rank = excluded.status_rank,
      has_value = excluded.has_value,
      collected_at = excluded.collected_at,
      updated_at = excluded.updated_at
    WHERE excluded.status_rank > keyword_metric_current.status_rank
       OR (excluded.status_rank = keyword_metric_current.status_rank
           AND (
             excluded.has_value > keyword_metric_current.has_value
             OR (
               excluded.has_value = keyword_metric_current.has_value
               AND excluded.collected_at >= keyword_metric_current.collected_at
             )
           ))
  `).run(
    record.keywordId,
    record.sourceId,
    record.metricCode,
    record.periodStart,
    record.periodEnd,
    observationId,
    statusRank(status),
    hasValue,
    collectedAt,
    nowIso()
  );
  return { observationId, inserted: Number(result.changes || 0) > 0, contentHash };
}

function upsertCompanyObservation(database, record) {
  let status = normalizeStatus(record.status);
  const hasValue = Number(
    [record.rankValue, record.supply, record.available, record.sold, record.saleRate, record.priceNum]
      .some((value) => numberOrNull(value) !== null)
    || Boolean(cleanText(record.priceText))
  );
  if (status === "complete" && !hasValue) status = "no_data";
  const collectedAt = cleanText(record.collectedAt) || nowIso();
  const channelCode = cleanText(record.channelCode) || "naver";
  const productKey = cleanText(record.productKey);
  const stayDate = cleanText(record.stayDate);
  const inventoryGroup = cleanText(record.inventoryGroup) || "unknown";
  const rawJson = safeJson(record.raw ?? null);
  const contentHash = sha256Buffer(Buffer.from(safeJson({
    runId: record.runId ?? null,
    companyId: record.companyId,
    keywordId: record.keywordId ?? null,
    sourceId: record.sourceId,
    channelCode,
    collectedAt,
    stayDate: stayDate || null,
    leadTimeDays: record.leadTimeDays ?? null,
    rankValue: record.rankValue ?? null,
    productKey,
    productType: record.productType ?? null,
    inventoryGroup,
    supply: record.supply ?? null,
    available: record.available ?? null,
    sold: record.sold ?? null,
    saleRate: record.saleRate ?? null,
    priceNum: record.priceNum ?? null,
    priceText: record.priceText ?? null,
    status,
    confidenceGrade: record.confidenceGrade ?? null,
    confidenceScore: record.confidenceScore ?? null,
    sourceUrl: record.sourceUrl ?? null,
    sourceArtifactId: record.sourceArtifactId ?? null,
    raw: record.raw ?? null
  })));
  const observationId = cleanText(record.observationId) || stableId(
    "co",
    record.runId,
    record.companyId,
    stayDate,
    productKey,
    channelCode,
    inventoryGroup,
    record.sourceId,
    collectedAt,
    contentHash
  );
  const existing = database.prepare("SELECT content_hash FROM company_observations WHERE observation_id = ?").get(observationId);
  if (existing && existing.content_hash !== contentHash) {
    const error = new Error(`같은 업체 관측 ID에 다른 내용이 들어왔습니다: ${observationId}`);
    error.code = "immutable_company_observation_conflict";
    throw error;
  }
  const result = database.prepare(`
    INSERT INTO company_observations (
      observation_id, run_id, company_id, keyword_id, source_id, channel_code,
      collected_at, stay_date, lead_time_days, rank_value, product_key, product_type,
      inventory_group, supply, available, sold, sale_rate, price_num, price_text,
      status, status_rank, confidence_grade, confidence_score, source_url,
      source_artifact_id, content_hash, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(observation_id) DO NOTHING
  `).run(
    observationId,
    record.runId ?? null,
    record.companyId,
    record.keywordId ?? null,
    record.sourceId,
    channelCode,
    collectedAt,
    stayDate || null,
    record.leadTimeDays ?? null,
    record.rankValue ?? null,
    productKey,
    record.productType ?? null,
    inventoryGroup,
    record.supply ?? null,
    record.available ?? null,
    record.sold ?? null,
    record.saleRate ?? null,
    record.priceNum ?? null,
    record.priceText ?? null,
    status,
    statusRank(status),
    record.confidenceGrade ?? null,
    record.confidenceScore ?? null,
    record.sourceUrl ?? null,
    record.sourceArtifactId ?? null,
    contentHash,
    rawJson,
    nowIso()
  );
  database.prepare(`
    INSERT INTO company_observation_current (
      company_id, stay_date, product_key, channel_code, inventory_group,
      source_id, observation_id, status_rank, has_value, collected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, stay_date, product_key, channel_code, inventory_group, source_id) DO UPDATE SET
      observation_id = excluded.observation_id,
      status_rank = excluded.status_rank,
      has_value = excluded.has_value,
      collected_at = excluded.collected_at,
      updated_at = excluded.updated_at
    WHERE excluded.status_rank > company_observation_current.status_rank
       OR (excluded.status_rank = company_observation_current.status_rank
           AND (
             excluded.has_value > company_observation_current.has_value
             OR (
               excluded.has_value = company_observation_current.has_value
               AND excluded.collected_at >= company_observation_current.collected_at
             )
           ))
  `).run(
    record.companyId,
    stayDate,
    productKey,
    channelCode,
    inventoryGroup,
    record.sourceId,
    observationId,
    statusRank(status),
    hasValue,
    collectedAt,
    nowIso()
  );
  return { observationId, inserted: Number(result.changes || 0) > 0, contentHash };
}

module.exports = {
  ROOT,
  SCHEMA_FILE,
  SCHEMA_VERSION,
  STATUS_RANKS,
  nowIso,
  cleanText,
  normalizeKey,
  normalizeStatus,
  statusRank,
  safeJson,
  stableId,
  sha256Buffer,
  sha256File,
  numberOrNull,
  parsePrice,
  getDatabaseSync,
  openMasterDatabase,
  applySchema,
  withTransaction,
  upsertRegionMetric,
  upsertKeywordMetric,
  upsertCompanyObservation
};
