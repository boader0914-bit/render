const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
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
  openMasterDatabase,
  applySchema,
  withTransaction,
  upsertRegionMetric,
  upsertKeywordMetric,
  upsertCompanyObservation
} = require("./master_db.cjs");
const { validateCompanyObservation } = require("./master_db_quality.cjs");

const SOURCE_DEFINITIONS = Object.freeze([
  ["region_catalog", "region", "행정구역·입지 사전", "reference", "on_release", "official"],
  ["naver_place", "company", "네이버 플레이스 수집", "crawler", "on_collection", "public_observation"],
  ["naver_searchad", "keyword", "네이버 검색광고 키워드", "api", "on_collection", "public_api"],
  ["naver_datalab", "keyword", "네이버 검색트렌드", "api", "on_collection", "public_api"],
  ["kto_datalab_download", "region", "한국관광 데이터랩 공식 다운로드", "official_download", "monthly", "official"],
  ["kto_visitor_api", "region", "한국관광공사 지역별 방문자 API", "public_api", "monthly", "official"],
  ["kto_demand_strength_api", "region", "한국관광공사 관광 수요 강도 API", "public_api", "monthly", "official"],
  ["kto_resource_demand_api", "region", "한국관광공사 관광자원 수요 API", "public_api", "monthly", "official"],
  ["kto_tourism_diversity_api", "region", "한국관광공사 관광 다양성 API", "public_api", "monthly", "official"],
  ["internal_booking", "company", "업체 내부 예약 실적", "private_import", "on_import", "verified_internal"],
  ["admin_manual", "company", "관리자 확정·보정", "manual", "on_change", "verified_admin"],
  ["legacy_file", "mixed", "기존 운영 파일", "legacy", "on_import", "legacy"]
]);

const CATEGORY_DEFINITIONS = Object.freeze([
  ["lodging", "숙박", null],
  ["glamping", "글램핑", "lodging"],
  ["campground", "캠핑장", "lodging"],
  ["caravan", "카라반", "lodging"],
  ["pension", "펜션", "lodging"],
  ["pool_villa", "풀빌라", "lodging"]
]);

const SENSITIVE_FIELD_PATTERN = /(password|secret|api.?key|service.?key|token|authorization|cookie|business.?registration.?(no|number)|registration.?number|representative|phone(number)?|mobile(phone|number|tel)|email(address)?)/i;

function redactSensitiveText(value) {
  return cleanText(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/([?&](?:serviceKey|apiKey|key|token|authorization|password|secret)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(?:password|secret|api.?key|service.?key|token|authorization)\s*[:=]\s*[^\s,;&]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b0\d{1,2}-\d{3,4}-\d{4}\b/g, "[redacted-phone]")
    .replace(/\b\d{3}-\d{2}-\d{5}\b/g, "[redacted-business-id]");
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_FIELD_PATTERN.test(key) ? "[redacted]" : redactSensitive(item)
  ]));
}

function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    json: false,
    dataDir: path.resolve(process.env.DATA_DIR || ROOT),
    databasePath: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--data-dir") options.dataDir = path.resolve(argv[++index] || "");
    else if (arg === "--db") options.databasePath = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  if (!options.databasePath) {
    options.databasePath = path.join(options.dataDir, "master_db", "sabun_master.sqlite");
  }
  return options;
}

function usage() {
  return [
    "사용법:",
    "  node scripts/master_db_import.cjs --dry-run [--data-dir PATH] [--json]",
    "  node scripts/master_db_import.cjs --apply [--data-dir PATH] [--db PATH] [--json]",
    "",
    "기본은 dry-run이며 기존 JSON/JSONL/CSV/XLSX 파일을 수정하거나 삭제하지 않습니다."
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        error.message = `${filePath}:${index + 1} ${error.message}`;
        throw error;
      }
    });
}

function listFilesRecursive(directoryPath, predicate = () => true) {
  if (!fs.existsSync(directoryPath)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && predicate(filePath)) files.push(filePath);
    }
  };
  visit(directoryPath);
  return files.sort((a, b) => a.localeCompare(b, "ko"));
}

function uniqueExisting(paths) {
  return [...new Set(paths.map((item) => path.resolve(item)).filter((item) => fs.existsSync(item)))];
}

function sourceIdForFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (["region_master.json", "tourism_region_map.json", "location_dictionary.json"].includes(name)) return "region_catalog";
  if (name === "companies.json" || name === "observations.jsonl" || name === "manifest.json") return "naver_place";
  if (name === "traffic_metrics.json") return "naver_searchad";
  if (name === "datalab_trends.json") return "naver_datalab";
  if (["location_card_requests.json", "location_score_overrides.json"].includes(name)) return "admin_manual";
  if (normalized.includes("period_summaries/")) return "kto_datalab_download";
  if (normalized.includes("tourism_data/cache/") || normalized.includes("tourism_data/evidence/cache_snapshots/")) {
    if (normalized.includes("resource")) return "kto_resource_demand_api";
    if (normalized.includes("diversity")) return "kto_tourism_diversity_api";
    if (normalized.includes("demand") || normalized.includes("strength")) return "kto_demand_strength_api";
    if (normalized.includes("visitor")) return "kto_visitor_api";
  }
  if (normalized.includes("outputs/")) return "naver_place";
  return "legacy_file";
}

function relativeArtifactPath(filePath, dataDir) {
  const absolute = path.resolve(filePath);
  const dataRelative = path.relative(dataDir, absolute);
  if (dataRelative && !dataRelative.startsWith("..") && !path.isAbsolute(dataRelative)) {
    return dataRelative.replace(/\\/g, "/");
  }
  const repoRelative = path.relative(ROOT, absolute);
  if (repoRelative && !repoRelative.startsWith("..") && !path.isAbsolute(repoRelative)) {
    return `app/${repoRelative.replace(/\\/g, "/")}`;
  }
  return `external/${path.basename(filePath)}`;
}

function manifestFileName(value) {
  if (typeof value === "string") return cleanText(value);
  if (value && typeof value === "object") return cleanText(value.file || value.path || value.relativePath);
  return "";
}

function manifestListedFileNames(manifest = {}) {
  return [...new Set([
    ...(Array.isArray(manifest.files) ? manifest.files : []),
    ...(Array.isArray(manifest.detailJsonFiles) ? manifest.detailJsonFiles : [])
  ].map(manifestFileName).filter(Boolean))];
}

function manifestCompletedAt(manifest = {}, manifestPath = "", fallback = "") {
  return manifest.completedAt
    || manifest.finishedAt
    || manifest.collectedAt
    || fallback
    || manifest.startedAt
    || (manifestPath && fs.existsSync(manifestPath) ? fs.statSync(manifestPath).mtime.toISOString() : null);
}

function artifactType(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === "manifest.json") return "manifest";
  if (name === "traffic_metrics.json") return "keyword_metrics";
  if (name.endsWith(".jsonl")) return "json_lines";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".md")) return "report";
  return "file";
}

function artifactRole(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === "region_master.json") return "administrative_region_master";
  if (name === "tourism_region_map.json") return "tourism_region_mapping";
  if (name === "location_dictionary.json") return "location_dictionary";
  if (name === "companies.json") return "company_master";
  if (name === "observations.jsonl") return "company_observation_history";
  if (name === "manifest.json") return "collection_manifest";
  if (name === "traffic_metrics.json") return "keyword_metrics";
  return path.extname(name).slice(1) || "file";
}

function collectSourceFiles(dataDir) {
  const staticFiles = [
    path.join(ROOT, "web", "data", "region_master.json"),
    path.join(ROOT, "web", "data", "tourism_region_map.json"),
    path.join(ROOT, "web", "data", "location_dictionary.json")
  ];
  const mutableFiles = [
    path.join(dataDir, "company_master", "companies.json"),
    path.join(dataDir, "history", "observations.jsonl"),
    path.join(dataDir, "history", "datalab_trends.json"),
    path.join(dataDir, "history", "crawl_timings.json"),
    path.join(dataDir, "config", "location_card_requests.json"),
    path.join(dataDir, "config", "location_score_overrides.json")
  ];
  const outputFiles = listFilesRecursive(path.join(dataDir, "outputs"), (filePath) => (
    !filePath.toLowerCase().endsWith(".inspect.ndjson")
  ));
  const tourismFiles = listFilesRecursive(path.join(dataDir, "tourism_data"), (filePath) => (
    !filePath.toLowerCase().endsWith(".tmp")
  ));
  return uniqueExisting([...staticFiles, ...mutableFiles, ...outputFiles, ...tourismFiles]);
}

function inspectInputs(dataDir) {
  const files = collectSourceFiles(dataDir);
  const find = (name) => files.find((filePath) => path.basename(filePath).toLowerCase() === name);
  const report = {
    mode: "dry-run",
    dataDir,
    existingFilesWillChange: false,
    credentialsIncluded: false,
    files: files.length,
    bytes: files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0),
    regions: 0,
    tourismRegionMappings: 0,
    companies: 0,
    historyObservations: 0,
    manifests: files.filter((filePath) => path.basename(filePath).toLowerCase() === "manifest.json").length,
    keywordMetrics: 0,
    tourismPeriodSummaries: files.filter((filePath) => filePath.replace(/\\/g, "/").includes("/period_summaries/")).length,
    tourismCacheSnapshots: files.filter((filePath) => filePath.replace(/\\/g, "/").includes("/tourism_data/cache/") && filePath.endsWith(".json")).length,
    parseErrors: []
  };
  const probes = [
    ["region_master.json", (value) => { report.regions = Array.isArray(value.units) ? value.units.length : 0; }],
    ["tourism_region_map.json", (value) => { report.tourismRegionMappings = Array.isArray(value.regions) ? value.regions.length : 0; }],
    ["companies.json", (value) => { report.companies = Array.isArray(value.companies) ? value.companies.length : Object.keys(value.companies || {}).length; }],
    ["observations.jsonl", (_value, filePath) => { report.historyObservations = readJsonLines(filePath).length; }]
  ];
  for (const [name, consume] of probes) {
    const filePath = find(name);
    if (!filePath) continue;
    try {
      consume(name.endsWith(".jsonl") ? null : readJson(filePath), filePath);
    } catch (error) {
      report.parseErrors.push({ file: relativeArtifactPath(filePath, dataDir), error: error.message });
    }
  }
  for (const filePath of files.filter((item) => path.basename(item).toLowerCase() === "traffic_metrics.json")) {
    try {
      const value = readJson(filePath);
      report.keywordMetrics += Array.isArray(value.metrics) ? value.metrics.length : Object.keys(value.metrics || {}).length;
    } catch (error) {
      report.parseErrors.push({ file: relativeArtifactPath(filePath, dataDir), error: error.message });
    }
  }
  for (const filePath of files.filter((item) => (
    item.replace(/\\/g, "/").includes("/tourism_data/cache/")
    && item.toLowerCase().endsWith(".json")
  ))) {
    try {
      const snapshot = readJson(filePath);
      if (!tourismSourceFromSnapshot(snapshot, filePath)) throw new Error("관광 API 출처를 판별할 수 없습니다.");
      const range = monthRange(snapshot.yearMonth);
      if (!range.start || !range.end) throw new Error("yearMonth가 YYYYMM 형식이 아닙니다.");
    } catch (error) {
      report.parseErrors.push({ file: relativeArtifactPath(filePath, dataDir), error: error.message });
    }
  }
  return report;
}

function seedReferenceTables(database) {
  const at = nowIso();
  const sourceStatement = database.prepare(`
    INSERT INTO data_sources (
      source_id, domain, source_name, source_type, update_cycle,
      authority_level, active, description, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      domain = excluded.domain,
      source_name = excluded.source_name,
      source_type = excluded.source_type,
      update_cycle = excluded.update_cycle,
      authority_level = excluded.authority_level,
      active = excluded.active,
      description = excluded.description,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  for (const [sourceId, domain, name, type, cycle, authority] of SOURCE_DEFINITIONS) {
    sourceStatement.run(sourceId, domain, name, type, cycle, authority, `${cycle} 기준으로 갱신`, safeJson({ sourceId }), at);
  }
  const categoryStatement = database.prepare(`
    INSERT INTO business_categories (
      category_code, category_name, parent_category_code, active, raw_json, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(category_code) DO UPDATE SET
      category_name = excluded.category_name,
      parent_category_code = excluded.parent_category_code,
      active = excluded.active,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  for (const [code, name, parent] of CATEGORY_DEFINITIONS) {
    categoryStatement.run(code, name, parent, safeJson({ code, name, parent }), at);
  }
}

function registerArtifact(database, filePath, dataDir, runId = null, sourceOverride = "") {
  const sourceId = sourceOverride || sourceIdForFile(filePath);
  const relativePath = relativeArtifactPath(filePath, dataDir);
  const stats = fs.statSync(filePath);
  const modifiedAt = stats.mtime.toISOString();
  const sha256 = sha256File(filePath);
  const unchanged = database.prepare(`
    SELECT artifact_id, sha256
    FROM source_artifacts
    WHERE source_id = ?
      AND relative_path = ?
      AND sha256 = ?
    ORDER BY ingested_at DESC
    LIMIT 1
  `).get(sourceId, relativePath, sha256);
  if (unchanged) {
    database.prepare(`
      UPDATE source_artifacts
      SET run_id = COALESCE(?, run_id), ingested_at = ?
      WHERE artifact_id = ?
    `).run(runId, nowIso(), unchanged.artifact_id);
    database.prepare(`
      INSERT INTO legacy_import_ledger (
        ledger_id, source_artifact_id, legacy_record_key, target_table,
        target_record_id, import_status, reason, imported_at
      ) VALUES (?, ?, 'file', 'source_artifacts', ?, 'imported', 'unchanged_file_reused', ?)
      ON CONFLICT(source_artifact_id, legacy_record_key, target_table) DO UPDATE SET
        target_record_id = excluded.target_record_id,
        import_status = excluded.import_status,
        reason = excluded.reason,
        imported_at = excluded.imported_at
    `).run(
      stableId("ledger", unchanged.artifact_id, "file"),
      unchanged.artifact_id,
      unchanged.artifact_id,
      nowIso()
    );
    return unchanged.artifact_id;
  }
  const artifactId = stableId("art", sourceId, relativePath, sha256);
  database.prepare(`
    INSERT INTO source_artifacts (
      artifact_id, source_id, run_id, artifact_type, file_role, relative_path,
      sha256, byte_size, modified_at, ingested_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET
      run_id = COALESCE(excluded.run_id, source_artifacts.run_id),
      file_role = excluded.file_role,
      byte_size = excluded.byte_size,
      modified_at = excluded.modified_at,
      ingested_at = excluded.ingested_at,
      raw_json = excluded.raw_json
  `).run(
    artifactId,
    sourceId,
    runId,
    artifactType(filePath),
    artifactRole(filePath),
    relativePath,
    sha256,
    stats.size,
    modifiedAt,
    nowIso(),
    safeJson({ originalPath: relativePath })
  );
  database.prepare(`
    INSERT INTO legacy_import_ledger (
      ledger_id, source_artifact_id, legacy_record_key, target_table,
      target_record_id, import_status, reason, imported_at
    ) VALUES (?, ?, 'file', 'source_artifacts', ?, 'imported', NULL, ?)
    ON CONFLICT(source_artifact_id, legacy_record_key, target_table) DO UPDATE SET
      target_record_id = excluded.target_record_id,
      import_status = excluded.import_status,
      reason = excluded.reason,
      imported_at = excluded.imported_at
  `).run(stableId("ledger", artifactId, "file"), artifactId, artifactId, nowIso());
  return artifactId;
}

function recordImportLedger(database, record) {
  if (!record.sourceArtifactId || !record.legacyRecordKey || !record.targetTable) return null;
  const ledgerId = stableId(
    "ledger",
    record.sourceArtifactId,
    record.legacyRecordKey,
    record.targetTable
  );
  database.prepare(`
    INSERT INTO legacy_import_ledger (
      ledger_id, source_artifact_id, legacy_record_key, target_table,
      target_record_id, import_status, reason, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_artifact_id, legacy_record_key, target_table) DO UPDATE SET
      target_record_id = excluded.target_record_id,
      import_status = excluded.import_status,
      reason = excluded.reason,
      imported_at = excluded.imported_at
  `).run(
    ledgerId,
    record.sourceArtifactId,
    record.legacyRecordKey,
    record.targetTable,
    record.targetRecordId || null,
    record.importStatus || "imported",
    record.reason || null,
    nowIso()
  );
  return ledgerId;
}

function importRegions(database, filePath, artifactId) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const units = Array.isArray(document.units) ? document.units : [];
  const at = document.generatedAt || nowIso();
  const insert = database.prepare(`
    INSERT INTO administrative_regions (
      region_id, region_key, parent_region_id, province_region_id, official_code,
      code5, level, unit_type, official_unit_label, name, short_name, full_name,
      sido, sido_full, sigungu, active, selectable, status, active_from, active_to,
      first_observed_at, last_observed_at, raw_json, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(region_id) DO UPDATE SET
      region_key = excluded.region_key,
      official_code = excluded.official_code,
      code5 = excluded.code5,
      level = excluded.level,
      unit_type = excluded.unit_type,
      official_unit_label = excluded.official_unit_label,
      name = excluded.name,
      short_name = excluded.short_name,
      full_name = excluded.full_name,
      sido = excluded.sido,
      sido_full = excluded.sido_full,
      sigungu = excluded.sigungu,
      active = excluded.active,
      selectable = excluded.selectable,
      status = excluded.status,
      active_from = excluded.active_from,
      active_to = excluded.active_to,
      first_observed_at = excluded.first_observed_at,
      last_observed_at = excluded.last_observed_at,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  for (const unit of units) {
    const regionId = cleanText(unit.regionId || unit.regionKey);
    if (!regionId) continue;
    insert.run(
      regionId,
      cleanText(unit.regionKey || regionId),
      cleanText(unit.officialCode) || null,
      cleanText(unit.code5) || null,
      cleanText(unit.level) || "unknown",
      cleanText(unit.unitType) || null,
      cleanText(unit.officialUnitLabel) || null,
      cleanText(unit.name || unit.fullName || regionId),
      cleanText(unit.shortName) || null,
      cleanText(unit.fullName || unit.name || regionId),
      cleanText(unit.sido) || null,
      cleanText(unit.sidoFull) || null,
      cleanText(unit.sigungu) || null,
      unit.active === false ? 0 : 1,
      unit.selectable ? 1 : 0,
      cleanText(unit.status) || (unit.active === false ? "inactive" : "active"),
      unit.activeFrom || null,
      unit.activeTo || null,
      unit.firstObservedAt || null,
      unit.lastObservedAt || null,
      safeJson(redactSensitive({ ...unit, sourceArtifactId: artifactId })),
      at
    );
  }
  database.prepare(`
    INSERT INTO administrative_regions (
      region_id, region_key, level, unit_type, name, short_name, full_name,
      active, selectable, status, raw_json, updated_at
    ) VALUES ('kr_national', 'kr_national', 'national', 'country', '대한민국', '전국', '대한민국', 1, 0, 'active', ?, ?)
    ON CONFLICT(region_id) DO UPDATE SET raw_json = excluded.raw_json, updated_at = excluded.updated_at
  `).run(safeJson({ synthetic: true, purpose: "national_official_metrics" }), at);

  const updateParents = database.prepare(`
    UPDATE administrative_regions
    SET parent_region_id = ?, province_region_id = ?, updated_at = ?
    WHERE region_id = ?
  `);
  for (const unit of units) {
    const regionId = cleanText(unit.regionId || unit.regionKey);
    if (!regionId) continue;
    const parentId = cleanText(unit.parentRegionId || unit.parentRegionKey) || null;
    const provinceId = cleanText(unit.provinceRegionId || unit.provinceRegionKey) || null;
    updateParents.run(parentId, provinceId, at, regionId);
  }

  const aliasStatement = database.prepare(`
    INSERT INTO region_aliases (region_id, alias, alias_key, source_id, updated_at)
    VALUES (?, ?, ?, 'region_catalog', ?)
    ON CONFLICT(region_id, alias_key, source_id) DO UPDATE SET
      alias = excluded.alias,
      updated_at = excluded.updated_at
  `);
  for (const unit of units) {
    const regionId = cleanText(unit.regionId || unit.regionKey);
    const aliases = new Set([
      unit.name,
      unit.shortName,
      unit.fullName,
      ...(Array.isArray(unit.aliases) ? unit.aliases : [])
    ].map(cleanText).filter(Boolean));
    for (const alias of aliases) aliasStatement.run(regionId, alias, normalizeKey(alias), at);
  }
  return units.length + 1;
}

function regionLookup(database) {
  const rows = database.prepare(`
    SELECT r.region_id, r.region_key, r.name, r.short_name, r.full_name, r.sido, r.sido_full, r.sigungu,
           GROUP_CONCAT(a.alias, '\u001f') AS aliases
    FROM administrative_regions r
    LEFT JOIN region_aliases a ON a.region_id = r.region_id
    GROUP BY r.region_id
  `).all();
  const byKey = new Map();
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    byId.set(row.region_id, row.region_id);
    byKey.set(row.region_key, row.region_id);
    const names = [row.name, row.short_name, row.full_name, row.sido, row.sido_full, row.sigungu, ...(row.aliases || "").split("\u001f")];
    for (const name of names.map(cleanText).filter(Boolean)) {
      const key = normalizeKey(name);
      if (!byName.has(key)) byName.set(key, row.region_id);
    }
  }
  return { byId, byKey, byName };
}

function resolveRegionId(value, lookup) {
  const text = cleanText(value);
  if (!text) return null;
  return lookup.byId.get(text) || lookup.byKey.get(text) || lookup.byName.get(normalizeKey(text)) || null;
}

function importTourismRegionMap(database, filePath, artifactId, lookup) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const regions = Array.isArray(document.regions) ? document.regions : [];
  const at = document.generatedAt || nowIso();
  const codeStatement = database.prepare(`
    INSERT INTO tourism_region_codes (
      region_id, code_system, code_value, code_basis, status, raw_json, updated_at
    ) VALUES (?, 'kto_signgu', ?, ?, ?, ?, ?)
    ON CONFLICT(code_system, code_value) DO UPDATE SET
      region_id = excluded.region_id,
      code_basis = excluded.code_basis,
      status = excluded.status,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  const aliasStatement = database.prepare(`
    INSERT INTO region_aliases (region_id, alias, alias_key, source_id, updated_at)
    VALUES (?, ?, ?, 'region_catalog', ?)
    ON CONFLICT(region_id, alias_key, source_id) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at
  `);
  for (const region of regions) {
    const regionId = resolveRegionId(region.officialRegionId || region.regionKey, lookup);
    const code = cleanText(region.ktoSggCd);
    if (!regionId || !code) continue;
    codeStatement.run(
      regionId,
      code,
      cleanText(region.codeBasis) || null,
      cleanText(region.status) || "complete",
      safeJson(redactSensitive({ ...region, sourceArtifactId: artifactId })),
      at
    );
    for (const alias of (Array.isArray(region.aliases) ? region.aliases : []).map(cleanText).filter(Boolean)) {
      aliasStatement.run(regionId, alias, normalizeKey(alias), at);
    }
  }
  return regions.length;
}

function importReferenceRecords(database, filePath, artifactId, lookup) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const collections = ["aliases", "scoreModels", "clusters", "cards", "regionGroups"];
  const at = document.generatedAt || nowIso();
  const statement = database.prepare(`
    INSERT INTO reference_records (
      record_id, record_type, record_key, region_id, source_id, title, status,
      valid_from, valid_to, source_artifact_id, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, 'region_catalog', ?, 'complete', NULL, NULL, ?, ?, ?)
    ON CONFLICT(record_type, record_key, source_id) DO UPDATE SET
      region_id = excluded.region_id,
      title = excluded.title,
      status = excluded.status,
      source_artifact_id = excluded.source_artifact_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  let count = 0;
  for (const collectionName of collections) {
    for (const item of (Array.isArray(document[collectionName]) ? document[collectionName] : [])) {
      const key = cleanText(item.code || item.regionKey || item.groupKey || item.searchKeyword)
        || stableId("refkey", safeJson(item));
      const recordType = `location_${collectionName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
      const regionId = resolveRegionId(item.regionKey, lookup);
      statement.run(
        stableId("ref", recordType, key),
        recordType,
        key,
        regionId,
        cleanText(item.name || item.searchKeyword || item.regionKey || key),
        artifactId,
        safeJson(redactSensitive(item)),
        at
      );
      count += 1;
    }
  }
  const metadata = ["source", "version"];
  for (const key of metadata) {
    if (document[key] === undefined) continue;
    statement.run(
      stableId("ref", "location_metadata", key),
      "location_metadata",
      key,
      null,
      key,
      artifactId,
      safeJson(redactSensitive(document[key])),
      at
    );
    count += 1;
  }
  return count;
}

function inferCategory(...values) {
  const text = values.map(cleanText).join(" ");
  if (text.includes("풀빌라")) return "pool_villa";
  if (text.includes("글램핑")) return "glamping";
  if (text.includes("카라반")) return "caravan";
  if (text.includes("캠핑")) return "campground";
  if (text.includes("펜션")) return "pension";
  return "lodging";
}

function channelFromUrl(value) {
  const url = cleanText(value).toLowerCase();
  if (url.includes("naver.com")) return "naver";
  if (url.includes("yeogi")) return "yeogi";
  if (url.includes("yanolja") || url.includes("nol.")) return "yanolja";
  if (url.includes("ddnayo")) return "ddnayo";
  return "other";
}

function storeCompanyExternalIdentity(database, record) {
  const companyId = cleanText(record.companyId);
  const providerCode = cleanText(record.providerCode);
  const externalId = cleanText(record.externalId);
  if (!companyId || !providerCode || !externalId) return { stored: false, reason: "missing_identity_field" };
  const existing = database.prepare(`
    SELECT company_id
    FROM company_external_ids
    WHERE provider_code = ? AND external_id = ?
  `).get(providerCode, externalId);
  if (existing && existing.company_id !== companyId) {
    const error = new Error(`${providerCode} 식별자 ${externalId}가 서로 다른 업체에 연결되어 반입을 중단합니다.`);
    error.code = "strong_company_identity_conflict";
    error.existingCompanyId = existing.company_id;
    error.incomingCompanyId = companyId;
    throw error;
  }
  database.prepare(`
    INSERT INTO company_external_ids (
      company_id, provider_code, external_id, status, verified_at, raw_json, updated_at
    ) VALUES (?, ?, ?, 'complete', ?, ?, ?)
    ON CONFLICT(provider_code, external_id) DO UPDATE SET
      status = excluded.status,
      verified_at = excluded.verified_at,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
    WHERE company_external_ids.company_id = excluded.company_id
  `).run(
    companyId,
    providerCode,
    externalId,
    record.verifiedAt || null,
    safeJson(redactSensitive(record.raw || { providerCode, externalId })),
    record.updatedAt || nowIso()
  );
  return { stored: true, companyId, providerCode, externalId };
}

function ensureKeyword(database, keyword, metadata = {}) {
  const text = cleanText(keyword);
  if (!text) return null;
  const keywordKey = normalizeKey(metadata.keywordKey || text);
  const keywordId = stableId("kw", keywordKey);
  database.prepare(`
    INSERT INTO keywords (
      keyword_id, keyword, keyword_key, keyword_type, region_id,
      business_category_code, active, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(keyword_key) DO UPDATE SET
      keyword = excluded.keyword,
      keyword_type = COALESCE(excluded.keyword_type, keywords.keyword_type),
      region_id = COALESCE(excluded.region_id, keywords.region_id),
      business_category_code = COALESCE(excluded.business_category_code, keywords.business_category_code),
      active = 1,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run(
    keywordId,
    text,
    keywordKey,
    metadata.keywordType || null,
    metadata.regionId || null,
    metadata.categoryCode || inferCategory(text),
    safeJson(redactSensitive(metadata.raw || { keyword: text })),
    metadata.updatedAt || nowIso()
  );
  return database.prepare("SELECT keyword_id FROM keywords WHERE keyword_key = ?").get(keywordKey).keyword_id;
}

function normalizedIsoOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function hasSnapshotEvidence(snapshot) {
  return [snapshot?.stockBasis, snapshot?.salesSignal, snapshot?.productSnapshot]
    .some((value) => value && typeof value === "object" && Object.keys(value).length > 0);
}

function importCompanies(database, filePath, artifactId, lookup) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const companies = Array.isArray(document.companies) ? document.companies : Object.values(document.companies || {});
  const at = document.updatedAt || nowIso();
  const companyStatement = database.prepare(`
    INSERT INTO companies (
      company_id, primary_name, name_key, loose_name_key, business_category_code,
      status, first_seen_at, last_seen_at, latest_run_id, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET
      primary_name = excluded.primary_name,
      name_key = excluded.name_key,
      loose_name_key = excluded.loose_name_key,
      business_category_code = excluded.business_category_code,
      status = excluded.status,
      first_seen_at = COALESCE(companies.first_seen_at, excluded.first_seen_at),
      last_seen_at = excluded.last_seen_at,
      latest_run_id = excluded.latest_run_id,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  const aliasStatement = database.prepare(`
    INSERT INTO company_aliases (company_id, alias, alias_key, source_id, updated_at)
    VALUES (?, ?, ?, 'naver_place', ?)
    ON CONFLICT(company_id, alias_key, source_id) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at
  `);
  const regionStatement = database.prepare(`
    INSERT INTO company_regions (
      company_id, region_id, region_label, relation_type, source_id, confidence_status, updated_at
    ) VALUES (?, ?, ?, 'observed', 'naver_place', ?, ?)
    ON CONFLICT(company_id, region_label, relation_type, source_id) DO UPDATE SET
      region_id = excluded.region_id,
      confidence_status = excluded.confidence_status,
      updated_at = excluded.updated_at
  `);
  const addressStatement = database.prepare(`
    INSERT INTO company_addresses (
      company_id, address_key, address, is_primary, source_id, updated_at
    ) VALUES (?, ?, ?, ?, 'naver_place', ?)
    ON CONFLICT(company_id, address_key, source_id) DO UPDATE SET
      address = excluded.address,
      is_primary = excluded.is_primary,
      updated_at = excluded.updated_at
  `);
  const urlStatement = database.prepare(`
    INSERT INTO company_urls (
      company_id, channel_code, url, relation_type, status, source_id, verified_at, updated_at
    ) VALUES (?, ?, ?, 'observed', 'complete', 'naver_place', ?, ?)
    ON CONFLICT(company_id, channel_code, url) DO UPDATE SET
      status = excluded.status,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at
  `);
  const referenceStatement = database.prepare(`
    INSERT INTO reference_records (
      record_id, record_type, record_key, region_id, source_id, title, status,
      source_artifact_id, payload_json, updated_at
    ) VALUES (?, ?, ?, NULL, 'admin_manual', ?, 'complete', ?, ?, ?)
    ON CONFLICT(record_type, record_key, source_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      source_artifact_id = excluded.source_artifact_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  const overrideStatement = database.prepare(`
    INSERT INTO manual_overrides (
      override_id, entity_type, entity_id, field_path, value_json, reason, status,
      effective_from, effective_to, created_by, created_at, updated_at
    ) VALUES (?, 'company', ?, '$', ?, 'legacy_company_master', 'active', NULL, NULL, 'legacy_admin', ?, ?)
    ON CONFLICT(override_id) DO UPDATE SET
      value_json = excluded.value_json,
      reason = excluded.reason,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const reviewStatement = database.prepare(`
    INSERT INTO quality_reviews (
      review_id, entity_type, entity_id, review_status, issue_code, note,
      evidence_json, reviewed_by, reviewed_at
    ) VALUES (?, 'company', ?, ?, ?, ?, ?, 'legacy_admin', ?)
    ON CONFLICT(review_id) DO UPDATE SET
      review_status = excluded.review_status,
      issue_code = excluded.issue_code,
      note = excluded.note,
      evidence_json = excluded.evidence_json,
      reviewed_at = excluded.reviewed_at
  `);
  const candidateStatement = database.prepare(`
    INSERT INTO company_match_candidates (
      candidate_id, company_id, candidate_type, candidate_key, match_status,
      confidence_score, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?)
    ON CONFLICT(candidate_type, candidate_key, company_id) DO UPDATE SET
      match_status = excluded.match_status,
      confidence_score = excluded.confidence_score,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  const snapshotStatement = database.prepare(`
    INSERT INTO company_snapshots (
      snapshot_id, company_id, run_id, source_id, snapshot_type, observed_at,
      content_hash, validation_status, status_rank, source_artifact_id,
      raw_json, created_at
    ) VALUES (?, ?, ?, 'naver_place', 'inventory_summary', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id) DO NOTHING
  `);
  const pointerStatement = database.prepare(`
    INSERT INTO company_snapshot_pointers (
      company_id, source_id, snapshot_type, snapshot_id, updated_at
    ) VALUES (?, 'naver_place', 'inventory_summary', ?, ?)
    ON CONFLICT(company_id, source_id, snapshot_type) DO UPDATE SET
      snapshot_id = excluded.snapshot_id,
      updated_at = excluded.updated_at
    WHERE (
      SELECT observed_at FROM company_snapshots WHERE snapshot_id = excluded.snapshot_id
    ) >= (
      SELECT observed_at FROM company_snapshots WHERE snapshot_id = company_snapshot_pointers.snapshot_id
    )
      AND (
        SELECT status_rank FROM company_snapshots WHERE snapshot_id = excluded.snapshot_id
      ) >= (
        SELECT status_rank FROM company_snapshots WHERE snapshot_id = company_snapshot_pointers.snapshot_id
      )
  `);

  for (const company of companies) {
    const companyId = cleanText(company.companyId) || stableId("cmp", company.primaryName, company.addresses?.[0], company.regions?.[0]);
    const primaryName = cleanText(company.primaryName) || "업체명 미확정";
    companyStatement.run(
      companyId,
      primaryName,
      cleanText(company.nameKey) || normalizeKey(primaryName),
      cleanText(company.looseNameKey) || null,
      inferCategory(primaryName, ...Object.keys(company.keywords || {})),
      company.firstSeenAt || null,
      company.lastSeenAt || null,
      company.lastRunId || null,
      safeJson(redactSensitive({ ...company, sourceArtifactId: artifactId })),
      at
    );
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: `company:${companyId}`,
      targetTable: "companies",
      targetRecordId: companyId
    });
    const aliases = new Set([primaryName, ...(Array.isArray(company.aliases) ? company.aliases : [])].map(cleanText).filter(Boolean));
    for (const alias of aliases) aliasStatement.run(companyId, alias, normalizeKey(alias), at);
    for (const placeId of (Array.isArray(company.placeIds) ? company.placeIds : []).map(cleanText).filter(Boolean)) {
      storeCompanyExternalIdentity(database, {
        companyId,
        providerCode: "naver_place",
        externalId: placeId,
        verifiedAt: company.lastSeenAt || null,
        updatedAt: at,
        raw: { placeId }
      });
    }
    for (const bookingId of (Array.isArray(company.bookingBusinessIds) ? company.bookingBusinessIds : []).map(cleanText).filter(Boolean)) {
      storeCompanyExternalIdentity(database, {
        companyId,
        providerCode: "naver_booking",
        externalId: bookingId,
        verifiedAt: company.lastSeenAt || null,
        updatedAt: at,
        raw: { bookingId }
      });
    }
    for (const regionLabel of (Array.isArray(company.regions) ? company.regions : []).map(cleanText).filter(Boolean)) {
      const regionId = resolveRegionId(regionLabel, lookup);
      regionStatement.run(companyId, regionId, regionLabel, regionId ? "matched" : "unverified", at);
    }
    const addresses = (Array.isArray(company.addresses) ? company.addresses : []).map(cleanText).filter(Boolean);
    addresses.forEach((address, index) => addressStatement.run(companyId, normalizeKey(address), address, index === 0 ? 1 : 0, at));
    for (const url of (Array.isArray(company.urls) ? company.urls : []).map(cleanText).filter(Boolean)) {
      urlStatement.run(companyId, channelFromUrl(url), url, company.lastSeenAt || null, at);
    }
    for (const entry of Object.values(company.keywords || {})) {
      ensureKeyword(database, entry.keyword || entry.keywordKey, {
        keywordKey: entry.keywordKey,
        keywordType: entry.keywordLayer || null,
        categoryCode: inferCategory(entry.keyword || entry.keywordKey),
        updatedAt: entry.lastSeenAt || at,
        raw: entry
      });
    }
    if (company.adminProfile) {
      referenceStatement.run(
        stableId("ref", "company_admin_profile", companyId),
        "company_admin_profile",
        companyId,
        primaryName,
        artifactId,
        safeJson(redactSensitive(company.adminProfile)),
        at
      );
    }
    if (company.inventory?.latest) {
      const candidates = [
        company.inventory.latest,
        ...(Array.isArray(company.inventory.snapshots) ? company.inventory.snapshots : []),
        ...(company.inventory.previousLatest && typeof company.inventory.previousLatest === "object" ? [company.inventory.previousLatest] : [])
      ].filter((snapshot) => snapshot && typeof snapshot === "object");
      for (const snapshot of candidates) {
        const snapshotJson = safeJson(redactSensitive(snapshot));
        const contentHash = sha256Buffer(Buffer.from(snapshotJson));
        const candidateRunId = cleanText(snapshot.runId || company.lastRunId);
        const runEvidence = candidateRunId
          ? database.prepare(`
              SELECT run.run_id, run.status_rank, artifact.sha256
              FROM collection_runs run
              LEFT JOIN source_artifacts artifact ON artifact.artifact_id = run.source_artifact_id
              WHERE run.run_id = ?
            `).get(candidateRunId)
          : null;
        const runId = runEvidence?.run_id || null;
        const snapshotId = stableId("snap", companyId, runId, "inventory_summary", contentHash);
        const normalizedCollectedAt = normalizedIsoOrNull(snapshot.collectedAt);
        const observedAt = normalizedCollectedAt
          || normalizedIsoOrNull(company.lastSeenAt)
          || normalizedIsoOrNull(at)
          || nowIso();
        const correctionApplied = Boolean(
          snapshot.manualCorrectionApplied
          || snapshot.salesSignal?.manualCorrectionApplied
          || snapshot.correctionBasis
        );
        const legacyCandidate = Boolean(
          !correctionApplied
          && runId
          && runEvidence.status_rank >= statusRank("complete")
          && /^[a-f0-9]{64}$/i.test(cleanText(runEvidence.sha256))
          && normalizedCollectedAt
          && ["A", "B"].includes(cleanText(snapshot.confidenceGrade))
          && hasSnapshotEvidence(snapshot)
        );
        const receiptEvidence = legacyCandidate
          ? database.prepare(`
              SELECT receipt_id
              FROM collection_receipts
              WHERE run_id = ?
                AND company_id = ?
                AND source_id = 'naver_place'
                AND status_rank >= ?
                AND source_artifact_id IS NOT NULL
                AND evidence_content_hash = ?
              ORDER BY created_at DESC
              LIMIT 1
            `).get(runId, companyId, statusRank("complete"), contentHash)
          : null;
        const accepted = Boolean(legacyCandidate && receiptEvidence);
        const validationStatus = accepted
          ? "accepted"
          : legacyCandidate
            ? "legacy_candidate"
            : "review_required";
        snapshotStatement.run(
          snapshotId,
          companyId,
          runId,
          observedAt,
          contentHash,
          validationStatus,
          accepted
            ? statusRank("complete")
            : legacyCandidate
              ? statusRank("partial")
              : statusRank("stale"),
          artifactId,
          snapshotJson,
          at
        );
        if (accepted) pointerStatement.run(companyId, snapshotId, at);
        const reviewReasons = [
          correctionApplied ? "manual_correction_applied" : "",
          !runId ? "missing_run" : "",
          runId && runEvidence.status_rank < statusRank("complete") ? "run_not_complete" : "",
          runId && !/^[a-f0-9]{64}$/i.test(cleanText(runEvidence.sha256)) ? "missing_evidence_sha256" : "",
          !normalizedCollectedAt ? "invalid_collected_at" : "",
          !["A", "B"].includes(cleanText(snapshot.confidenceGrade)) ? "low_confidence" : "",
          !hasSnapshotEvidence(snapshot) ? "missing_snapshot_evidence" : "",
          legacyCandidate && !receiptEvidence ? "missing_content_receipt" : ""
        ].filter(Boolean);
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `snapshot:${companyId}:${contentHash}`,
          targetTable: "company_snapshots",
          targetRecordId: snapshotId,
          importStatus: accepted ? "imported" : "review_required",
          reason: reviewReasons.join(",") || null
        });
      }
      referenceStatement.run(
        stableId("ref", "company_inventory_latest", companyId),
        "company_inventory_latest",
        companyId,
        primaryName,
        artifactId,
        safeJson(redactSensitive(company.inventory.latest)),
        company.inventory.latest.collectedAt || at
      );
    }
    if (company.manualCorrection) {
      overrideStatement.run(
        stableId("ovr", companyId, safeJson(company.manualCorrection)),
        companyId,
        safeJson(redactSensitive(company.manualCorrection)),
        company.manualCorrection.createdAt || at,
        company.manualCorrection.updatedAt || at
      );
    }
    if (company.adminReview) {
      reviewStatement.run(
        stableId("review", companyId, safeJson(company.adminReview)),
        companyId,
        cleanText(company.adminReview.status || company.adminReview.decision) || "reviewed",
        cleanText(company.adminReview.issueCode) || null,
        redactSensitiveText(company.adminReview.note) || null,
        safeJson(redactSensitive(company.adminReview)),
        company.adminReview.reviewedAt || company.adminReview.updatedAt || at
      );
    }
  }
  for (const [sourceKey, companyId] of Object.entries(document.sourceIndex || {})) {
    const separator = sourceKey.indexOf(":");
    const candidateType = separator > 0 ? sourceKey.slice(0, separator) : "legacy";
    const candidateKey = separator > 0 ? sourceKey.slice(separator + 1) : sourceKey;
    if (!database.prepare("SELECT company_id FROM companies WHERE company_id = ?").get(companyId)) continue;
    if (["place", "booking"].includes(candidateType)) {
      storeCompanyExternalIdentity(database, {
        companyId,
        providerCode: candidateType === "place" ? "naver_place" : "naver_booking",
        externalId: candidateKey,
        verifiedAt: at,
        updatedAt: at,
        raw: { sourceKey, companyId, importedFrom: "sourceIndex" }
      });
      continue;
    }
    if (!["name_addr", "name_region"].includes(candidateType)) continue;
    candidateStatement.run(
      stableId("match", candidateType, candidateKey, companyId),
      companyId,
      candidateType,
      candidateKey,
      candidateType === "name_addr" ? 0.6 : 0.4,
      safeJson(redactSensitive({ sourceKey, companyId, automaticMergeAllowed: false })),
      at
    );
  }
  const supplementalStatement = database.prepare(`
    INSERT INTO reference_records (
      record_id, record_type, record_key, region_id, source_id, title, status,
      source_artifact_id, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, 'admin_manual', ?, 'complete', ?, ?, ?)
    ON CONFLICT(record_type, record_key, source_id) DO UPDATE SET
      region_id = excluded.region_id,
      title = excluded.title,
      source_artifact_id = excluded.source_artifact_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  for (const [collectionName, sourceValue] of [
    ["company_duplicate_resolution", document.duplicateResolutions],
    ["company_region_review", document.regionReviews],
    ["company_region_review_history", document.regionReviewHistory]
  ]) {
    const items = Array.isArray(sourceValue) ? sourceValue : Object.values(sourceValue || {});
    items.forEach((item, index) => {
      const explicitId = cleanText(item?.id || item?.reviewId);
      const entityKey = cleanText(item?.companyId || item?.regionKey);
      const recordKey = explicitId || (
        collectionName.endsWith("_history") || collectionName.includes("duplicate")
          ? stableId("refkey", collectionName, entityKey, item?.updatedAt || item?.reviewedAt || index, safeJson(item))
          : entityKey || stableId("refkey", collectionName, index, safeJson(item))
      );
      supplementalStatement.run(
        stableId("ref", collectionName, recordKey),
        collectionName,
        recordKey,
        resolveRegionId(item?.regionKey || item?.region, lookup),
        cleanText(item?.name || item?.companyName || item?.regionKey || recordKey),
        artifactId,
        safeJson(redactSensitive(item)),
        item?.updatedAt || item?.reviewedAt || at
      );
    });
  }
  return companies.length;
}

function findOutputManifests(dataDir) {
  return listFilesRecursive(path.join(dataDir, "outputs"), (filePath) => path.basename(filePath).toLowerCase() === "manifest.json");
}

function monthRange(yearMonth) {
  const text = cleanText(yearMonth).replace(/[^0-9]/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(text)) return { start: "", end: "" };
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return { start: "", end: "" };
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${text.slice(0, 4)}-${text.slice(4, 6)}-01`,
    end: `${text.slice(0, 4)}-${text.slice(4, 6)}-${String(endDay).padStart(2, "0")}`
  };
}

function importRunManifests(database, dataDir, lookup) {
  const manifests = findOutputManifests(dataDir);
  const statement = database.prepare(`
    INSERT INTO collection_runs (
      run_id, source_id, run_label, keyword_id, query_text, search_mode, product_mode,
      period_start, period_end, started_at, completed_at, status, status_rank,
      source_artifact_id, raw_json, updated_at
    ) VALUES (?, 'naver_place', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      run_label = excluded.run_label,
      keyword_id = excluded.keyword_id,
      query_text = excluded.query_text,
      search_mode = excluded.search_mode,
      product_mode = excluded.product_mode,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      started_at = COALESCE(collection_runs.started_at, excluded.started_at),
      completed_at = excluded.completed_at,
      status = CASE WHEN excluded.status_rank >= collection_runs.status_rank THEN excluded.status ELSE collection_runs.status END,
      status_rank = MAX(collection_runs.status_rank, excluded.status_rank),
      source_artifact_id = excluded.source_artifact_id,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    const runId = path.basename(path.dirname(manifestPath));
    const artifactId = registerArtifact(database, manifestPath, dataDir, runId, "naver_place");
    for (const sibling of listFilesRecursive(path.dirname(manifestPath), (filePath) => !filePath.toLowerCase().endsWith(".inspect.ndjson"))) {
      registerArtifact(database, sibling, dataDir, runId);
    }
    const regionCandidate = cleanText(manifest.searchKeyword || manifest.keyword).replace(/(글램핑|캠핑장|카라반|펜션|풀빌라|숙박|숙소)/g, "").trim();
    const regionId = resolveRegionId(regionCandidate, lookup);
    const keywordId = ensureKeyword(database, manifest.keyword || manifest.searchKeyword, {
      keywordType: manifest.keywordType || null,
      regionId,
      categoryCode: inferCategory(manifest.keyword, manifest.searchKeyword),
      raw: manifest
    });
    const listed = manifestListedFileNames(manifest);
    const filesComplete = listed.length > 0 && listed.every((name) => {
      const filePath = path.resolve(path.dirname(manifestPath), name);
      const relative = path.relative(path.dirname(manifestPath), filePath);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        && fs.existsSync(filePath)
        && fs.statSync(filePath).isFile()
        && fs.statSync(filePath).size > 0;
    });
    const status = filesComplete ? "complete" : "partial";
    const completedAt = manifestCompletedAt(manifest, manifestPath);
    statement.run(
      runId,
      cleanText(manifest.keyword) || runId,
      keywordId,
      cleanText(manifest.searchKeyword || manifest.naverKeyword || manifest.keyword),
      cleanText(manifest.searchMode) || null,
      cleanText(manifest.productMode) || null,
      manifest.checkIn || null,
      manifest.checkOut || null,
      manifest.startedAt || null,
      completedAt,
      status,
      statusRank(status),
      artifactId,
      safeJson(redactSensitive(manifest)),
      nowIso()
    );
  }
  return manifests.length;
}

function observationCompanyId(observation = {}) {
  const companyKey = cleanText(observation.companyKey);
  if (/^cmp_place_\d+$/i.test(companyKey)) return companyKey.toLowerCase();
  const placeIdFromUrl = cleanText(observation.sourceUrl).match(/(?:place|accommodation)\/(\d{5,})/i)?.[1] || "";
  if (placeIdFromUrl) return `cmp_place_${placeIdFromUrl}`;
  return stableId("cmp_provisional", "naver_place", observation.companyName, observation.region);
}

function ensureCompany(database, observation, options = {}) {
  const companyId = observationCompanyId(observation);
  const provisional = companyId.startsWith("cmp_provisional_");
  const promotedCollectedAt = options.promoteCurrent === false ? null : (observation.collectedAt || null);
  const promotedRunId = options.promoteCurrent === false ? null : (observation.runId || null);
  const existing = database.prepare("SELECT company_id FROM companies WHERE company_id = ?").get(companyId);
  if (existing) {
    database.prepare(`
      UPDATE companies
      SET primary_name = CASE
            WHEN primary_name = '업체명 미확정' AND ? <> '' THEN ?
            ELSE primary_name
          END,
          name_key = CASE
            WHEN (name_key IS NULL OR name_key = '') AND ? <> '' THEN ?
            ELSE name_key
          END,
          last_seen_at = CASE
            WHEN ? IS NOT NULL AND (last_seen_at IS NULL OR ? >= last_seen_at) THEN ?
            ELSE last_seen_at
          END,
          latest_run_id = CASE
            WHEN ? IS NOT NULL AND (last_seen_at IS NULL OR ? >= last_seen_at) THEN COALESCE(?, latest_run_id)
            ELSE latest_run_id
          END,
          updated_at = ?
      WHERE company_id = ?
    `).run(
      cleanText(observation.companyName),
      cleanText(observation.companyName),
      normalizeKey(observation.companyName),
      normalizeKey(observation.companyName),
      promotedCollectedAt,
      promotedCollectedAt,
      promotedCollectedAt,
      promotedCollectedAt,
      promotedCollectedAt,
      promotedRunId,
      nowIso(),
      companyId
    );
    return companyId;
  }
  database.prepare(`
    INSERT INTO companies (
      company_id, primary_name, name_key, loose_name_key, business_category_code,
      status, first_seen_at, last_seen_at, latest_run_id, raw_json, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId,
    cleanText(observation.companyName) || "업체명 미확정",
    normalizeKey(observation.companyName),
    inferCategory(observation.companyName, observation.keyword),
    provisional ? "review_required" : "active",
    observation.collectedAt || null,
    promotedCollectedAt,
    promotedRunId,
    safeJson(redactSensitive({
      createdFromObservation: observation.observationId || null,
      identityBasis: provisional ? "name_region_provisional" : "naver_place_id"
    })),
    nowIso()
  );
  return companyId;
}

function ensureRunForObservation(database, observation, keywordId, artifactId) {
  const runId = cleanText(observation.runId) || stableId("run", observation.keyword, observation.collectedDate);
  const existing = database.prepare("SELECT run_id FROM collection_runs WHERE run_id = ?").get(runId);
  if (existing) return runId;
  database.prepare(`
    INSERT INTO collection_runs (
      run_id, source_id, run_label, keyword_id, query_text, search_mode, product_mode,
      period_start, period_end, started_at, completed_at, status, status_rank,
      source_artifact_id, raw_json, updated_at
    ) VALUES (?, 'naver_place', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'partial', ?, ?, ?, ?)
  `).run(
    runId,
    observation.runLabel || runId,
    keywordId,
    observation.keyword || null,
    observation.searchMode || null,
    observation.productMode || null,
    observation.stayDate || null,
    observation.stayDate || null,
    observation.collectedAt || null,
    statusRank("partial"),
    artifactId,
    safeJson(redactSensitive({ inferredFromHistory: true })),
    nowIso()
  );
  return runId;
}

function importHistoryObservationRows(database, observations = [], artifactId, options = {}) {
  const importedRows = [];
  for (const [observationIndex, observation] of observations.entries()) {
    if (options.runId && cleanText(observation.runId) !== cleanText(options.runId)) continue;
    const supply = numberOrNull(observation.supply);
    const available = numberOrNull(observation.available);
    const sold = numberOrNull(observation.sold);
    const defaultDecision = {
      status: supply === null && available === null && sold === null ? "partial" : "complete",
      promoteCurrent: true,
      qualityScore: null,
      reasons: []
    };
    const observationValidator = options.validateObservation === false
      ? null
      : (typeof options.validateObservation === "function" ? options.validateObservation : validateCompanyObservation);
    const validatedDecision = observationValidator
      ? observationValidator(observation)
      : null;
    const decision = validatedDecision && typeof validatedDecision === "object"
      ? {
        ...defaultDecision,
        ...validatedDecision,
        reasons: Array.isArray(validatedDecision.reasons) ? validatedDecision.reasons : []
      }
      : defaultDecision;
    const status = normalizeStatus(decision.status);
    const keywordId = ensureKeyword(database, observation.keyword || observation.keywordKey, {
      keywordKey: observation.keywordKey,
      categoryCode: inferCategory(observation.keyword),
      raw: { keyword: observation.keyword, keywordKey: observation.keywordKey }
    });
    const companyId = ensureCompany(database, observation, { promoteCurrent: decision.promoteCurrent !== false });
    const placeId = companyId.match(/^cmp_place_(\d+)$/)?.[1] || "";
    if (placeId) {
      storeCompanyExternalIdentity(database, {
        companyId,
        providerCode: "naver_place",
        externalId: placeId,
        verifiedAt: observation.collectedAt || null,
        updatedAt: observation.collectedAt || nowIso(),
        raw: { derivedFromCompanyKey: true, observationId: observation.observationId || null }
      });
    }
    const runId = ensureRunForObservation(database, observation, keywordId, artifactId);
    const imported = upsertCompanyObservation(database, {
      observationId: observation.observationId || stableId("co", runId, companyId, observation.productType, observation.stayDate),
      runId,
      companyId,
      keywordId,
      sourceId: "naver_place",
      channelCode: "naver",
      collectedAt: observation.collectedAt,
      stayDate: observation.stayDate || null,
      leadTimeDays: numberOrNull(observation.leadTimeDays),
      rankValue: numberOrNull(observation.rank),
      productKey: normalizeKey(observation.productType || "all"),
      productType: observation.productType || null,
      supply,
      available,
      sold,
      saleRate: numberOrNull(observation.saleRate),
      priceNum: parsePrice(observation.price),
      priceText: observation.price || null,
      status,
      confidenceGrade: observation.inventoryConfidenceGrade || null,
      confidenceScore: numberOrNull(observation.inventoryConfidenceScore),
      sourceUrl: redactSensitiveText(observation.sourceUrl) || null,
      sourceArtifactId: artifactId,
      promoteCurrent: decision.promoteCurrent !== false,
      raw: redactSensitive(observation)
    });
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: cleanText(observation.observationId) || `line:${observationIndex + 1}`,
      targetTable: "company_observations",
      targetRecordId: imported.observationId
    });
    importedRows.push({
      observationId: imported.observationId,
      inserted: imported.inserted,
      companyId,
      keywordId,
      runId,
      status,
      stayDate: observation.stayDate || null,
      qualityScore: numberOrNull(decision.qualityScore),
      qualityReasons: decision.reasons
    });
  }
  return { count: importedRows.length, rows: importedRows };
}

function importHistoryObservations(database, filePath, artifactId) {
  if (!filePath) return 0;
  return importHistoryObservationRows(database, readJsonLines(filePath), artifactId).count;
}

function importTrafficMetrics(database, dataDir) {
  const files = listFilesRecursive(path.join(dataDir, "outputs"), (filePath) => path.basename(filePath).toLowerCase() === "traffic_metrics.json");
  let count = 0;
  for (const filePath of files) {
    const document = readJson(filePath);
    const runId = path.basename(path.dirname(filePath));
    const artifactId = registerArtifact(database, filePath, dataDir, runId, "naver_searchad");
    const collectedAt = document.updatedAt || fs.statSync(filePath).mtime.toISOString();
    const period = collectedAt.slice(0, 10);
    const metrics = Array.isArray(document.metrics) ? document.metrics : Object.values(document.metrics || {});
    for (const metric of metrics) {
      const keywordId = ensureKeyword(database, metric.keyword || metric.relKeyword, {
        keywordKey: metric.relKeyword || metric.keyword,
        categoryCode: inferCategory(metric.keyword, metric.relKeyword),
        raw: metric,
        updatedAt: collectedAt
      });
      const status = metric.collectable === false ? "no_data" : Number(metric.status) === 200 ? "complete" : "error";
      const values = [
        ["monthly_pc_search_volume", metric.monthlyPc, "searches/month"],
        ["monthly_mobile_search_volume", metric.monthlyMobile, "searches/month"],
        ["total_search_volume", metric.totalSearchVolume, "searches/month"],
        ["monthly_pc_clicks", metric.monthlyPcClicks, "clicks/month"],
        ["monthly_mobile_clicks", metric.monthlyMobileClicks, "clicks/month"],
        ["total_clicks", metric.totalClicks, "clicks/month"],
        ["pc_ctr", metric.pcCtr, "percent"],
        ["mobile_ctr", metric.mobileCtr, "percent"],
        ["combined_ctr", metric.combinedCtr, "percent"]
      ];
      for (const [metricCode, value, unit] of values) {
        const numericValue = numberOrNull(value);
        const imported = upsertKeywordMetric(database, {
          runId,
          keywordId,
          sourceId: "naver_searchad",
          metricCode,
          periodStart: period,
          periodEnd: period,
          valueNum: numericValue,
          unit,
          status: numericValue === null && status === "complete" ? "partial" : status,
          collectedAt,
          sourceArtifactId: artifactId,
          raw: redactSensitive(metric)
        });
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `${normalizeKey(metric.keyword || metric.relKeyword)}:${metricCode}:${period}`,
          targetTable: "keyword_metric_observations",
          targetRecordId: imported.observationId
        });
      }
      const competitionImport = upsertKeywordMetric(database, {
        runId,
        keywordId,
        sourceId: "naver_searchad",
        metricCode: "competition",
        periodStart: period,
        periodEnd: period,
        valueText: cleanText(metric.competition) || null,
        unit: "level",
        status,
        collectedAt,
        sourceArtifactId: artifactId,
        raw: redactSensitive(metric)
      });
      recordImportLedger(database, {
        sourceArtifactId: artifactId,
        legacyRecordKey: `${normalizeKey(metric.keyword || metric.relKeyword)}:competition:${period}`,
        targetTable: "keyword_metric_observations",
        targetRecordId: competitionImport.observationId
      });
      count += 1;
    }
  }
  return count;
}

function metricPeriod(value) {
  const text = cleanText(value);
  const compact = text.replace(/[^0-9]/g, "");
  if (/^\d{6}$/.test(compact)) return monthRange(compact);
  if (/^\d{8}$/.test(compact)) {
    const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    return { start: date, end: date };
  }
  return { start: text, end: text };
}

function deterministicFileTime(filePath, ...candidates) {
  const explicit = candidates.map(cleanText).find(Boolean);
  return explicit || fs.statSync(filePath).mtime.toISOString();
}

function importDatalabTrends(database, filePath, artifactId) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const fileTime = deterministicFileTime(filePath, document.updatedAt);
  let count = 0;
  for (const entry of Object.values(document.keywords || {})) {
    const keywordId = ensureKeyword(database, entry.keyword || entry.keywordKey, {
      keywordKey: entry.keywordKey,
      categoryCode: inferCategory(entry.keyword || entry.keywordKey),
      raw: { keyword: entry.keyword, keywordKey: entry.keywordKey },
      updatedAt: deterministicFileTime(filePath, entry.lastCollectedAt, document.updatedAt)
    });
    const observations = Array.isArray(entry.observations) && entry.observations.length
      ? entry.observations
      : entry.latest
        ? [entry.latest]
        : [];
    for (const observation of observations) {
      const status = observation.collectable && Number(observation.status) === 200
        ? "complete"
        : observation.configured === false
          ? "no_data"
          : "error";
      const collectedAt = deterministicFileTime(
        filePath,
        observation.collectedAt,
        entry.lastCollectedAt,
        document.updatedAt,
        fileTime
      );
      const series = Array.isArray(observation.series) ? observation.series : [];
      const ranges = series
        .map((point) => metricPeriod(point.period || point.month))
        .filter((period) => period.start && period.end);
      const runId = stableId(
        "run",
        "naver_datalab",
        artifactId,
        keywordId,
        collectedAt,
        sha256Buffer(Buffer.from(safeJson(observation)))
      );
      insertCollectionRun(database, {
        runId,
        sourceId: "naver_datalab",
        runLabel: `네이버 검색트렌드 ${entry.keyword || entry.keywordKey || keywordId}`,
        keywordId,
        queryText: entry.keyword || entry.keywordKey || null,
        periodStart: ranges.map((period) => period.start).sort()[0] || null,
        periodEnd: ranges.map((period) => period.end).sort().at(-1) || null,
        completedAt: collectedAt,
        status,
        artifactId,
        raw: {
          keyword: entry.keyword || entry.keywordKey || null,
          collectedAt,
          seriesCount: series.length,
          sourceArtifactId: artifactId
        }
      });
      for (const point of series) {
        const period = metricPeriod(point.period || point.month);
        if (!period.start || !period.end) {
          recordImportLedger(database, {
            sourceArtifactId: artifactId,
            legacyRecordKey: `${normalizeKey(entry.keyword || entry.keywordKey)}:search_trend_ratio:${cleanText(point.period || point.month) || "unknown"}`,
            targetTable: "keyword_metric_observations",
            importStatus: "skipped",
            reason: "invalid_metric_period"
          });
          continue;
        }
        const value = numberOrNull(point.ratio ?? point.value);
        const imported = upsertKeywordMetric(database, {
          runId,
          keywordId,
          sourceId: "naver_datalab",
          metricCode: "search_trend_ratio",
          periodStart: period.start,
          periodEnd: period.end,
          valueNum: value,
          unit: "relative_index",
          status: value === null && status === "complete" ? "partial" : status,
          collectedAt,
          sourceArtifactId: artifactId,
          raw: redactSensitive({ observation, point })
        });
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `${normalizeKey(entry.keyword || entry.keywordKey)}:search_trend_ratio:${period.start}:${collectedAt}`,
          targetTable: "keyword_metric_observations",
          targetRecordId: imported.observationId
        });
        count += 1;
      }
    }
  }
  return count;
}

function importCrawlTimings(database, filePath, artifactId) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const statement = database.prepare(`
    INSERT INTO ops_job_runs (
      job_run_id, job_type, related_run_id, started_at, ended_at,
      duration_seconds, job_status, error_message, raw_json, updated_at
    ) VALUES (?, 'naver_collection', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_run_id) DO UPDATE SET
      related_run_id = excluded.related_run_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_seconds = excluded.duration_seconds,
      job_status = excluded.job_status,
      error_message = excluded.error_message,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  let count = 0;
  for (const entry of (Array.isArray(document.entries) ? document.entries : [])) {
    const relatedRunId = cleanText(entry.runId) && database.prepare("SELECT run_id FROM collection_runs WHERE run_id = ?").get(entry.runId)
      ? entry.runId
      : null;
    statement.run(
      cleanText(entry.id) || stableId("job", entry.startedAt, entry.keyword, entry.runId),
      relatedRunId,
      entry.startedAt || null,
      entry.endedAt || null,
      numberOrNull(entry.durationSeconds),
      entry.success === false ? "failed" : "succeeded",
      redactSensitiveText(entry.error) || null,
      safeJson(redactSensitive({ ...entry, sourceArtifactId: artifactId })),
      document.updatedAt || entry.endedAt || nowIso()
    );
    count += 1;
  }
  return count;
}

function importSafeAdminConfig(database, filePath, artifactId) {
  if (!filePath) return 0;
  const document = readJson(filePath);
  const recordKey = path.basename(filePath, path.extname(filePath));
  database.prepare(`
    INSERT INTO reference_records (
      record_id, record_type, record_key, region_id, source_id, title, status,
      source_artifact_id, payload_json, updated_at
    ) VALUES (?, 'admin_config', ?, NULL, 'admin_manual', ?, 'complete', ?, ?, ?)
    ON CONFLICT(record_type, record_key, source_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      source_artifact_id = excluded.source_artifact_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    stableId("ref", "admin_config", recordKey),
    recordKey,
    recordKey,
    artifactId,
    safeJson(redactSensitive(document)),
    document.updatedAt || fs.statSync(filePath).mtime.toISOString()
  );
  return 1;
}

function insertCollectionRun(database, record) {
  const status = normalizeStatus(record.status);
  database.prepare(`
    INSERT INTO collection_runs (
      run_id, source_id, run_label, keyword_id, query_text, search_mode, product_mode,
      period_start, period_end, started_at, completed_at, status, status_rank,
      source_artifact_id, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      keyword_id = COALESCE(excluded.keyword_id, collection_runs.keyword_id),
      query_text = COALESCE(excluded.query_text, collection_runs.query_text),
      search_mode = COALESCE(excluded.search_mode, collection_runs.search_mode),
      product_mode = COALESCE(excluded.product_mode, collection_runs.product_mode),
      period_start = COALESCE(excluded.period_start, collection_runs.period_start),
      period_end = COALESCE(excluded.period_end, collection_runs.period_end),
      started_at = COALESCE(collection_runs.started_at, excluded.started_at),
      completed_at = excluded.completed_at,
      status = CASE WHEN excluded.status_rank >= collection_runs.status_rank THEN excluded.status ELSE collection_runs.status END,
      status_rank = MAX(collection_runs.status_rank, excluded.status_rank),
      source_artifact_id = excluded.source_artifact_id,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run(
    record.runId,
    record.sourceId,
    record.runLabel,
    record.keywordId || null,
    record.queryText || null,
    record.searchMode || null,
    record.productMode || null,
    record.periodStart,
    record.periodEnd,
    record.startedAt || null,
    record.completedAt,
    status,
    statusRank(status),
    record.artifactId,
    safeJson(redactSensitive(record.raw)),
    nowIso()
  );
}

function importTourismPeriodSummaries(database, dataDir, lookup) {
  const directory = path.join(dataDir, "tourism_data", "period_summaries");
  const files = listFilesRecursive(directory, (filePath) => filePath.toLowerCase().endsWith(".json"));
  let metricCount = 0;
  for (const filePath of files) {
    const document = readJson(filePath);
    const artifactId = registerArtifact(database, filePath, dataDir, null, "kto_datalab_download");
    const startYm = document.period?.startYearMonth || "";
    const endYm = document.period?.endYearMonth || "";
    const start = monthRange(startYm).start;
    const end = monthRange(endYm).end;
    const runId = stableId("run", "kto_datalab_download", startYm, endYm, document.source?.archiveSha256 || artifactId);
    const status = document.quality?.status || document.status || "partial";
    insertCollectionRun(database, {
      runId,
      sourceId: "kto_datalab_download",
      runLabel: `관광 데이터랩 ${startYm}-${endYm}`,
      periodStart: start,
      periodEnd: end,
      completedAt: document.collectedAt || document.source?.downloadedAt || fs.statSync(filePath).mtime.toISOString(),
      status,
      artifactId,
      raw: {
        schemaVersion: document.schemaVersion,
        adapter: document.adapter,
        status: document.status,
        reason: document.reason,
        period: document.period,
        source: document.source,
        quality: document.quality,
        policy: document.policy,
        sourceArtifactId: artifactId
      }
    });
    database.prepare("UPDATE source_artifacts SET run_id = ? WHERE artifact_id = ?").run(runId, artifactId);
    const collectedAt = deterministicFileTime(filePath, document.collectedAt, document.source?.downloadedAt);
    const qualityScore = document.quality?.status === "complete" ? 1 : null;
    const regionalGroups = [
      ["period_broad", document.broadRegions || []],
      ["period_local", document.localRegions || []]
    ];
    for (const [grain, rows] of regionalGroups) {
      for (const row of rows) {
        const regionId = resolveRegionId(
          row.historicalRegionKey || row.currentRegionKey || row.regionKey || row.currentRegion?.regionKey,
          lookup
        );
        if (!regionId) {
          recordImportLedger(database, {
            sourceArtifactId: artifactId,
            legacyRecordKey: `${grain}:${row.historicalRegionKey || row.currentRegionKey || row.regionKey || "unknown"}:region`,
            targetTable: "region_metric_observations",
            importStatus: "skipped",
            reason: "unmatched_region"
          });
          continue;
        }
        const values = [
          [`${grain}.visitor_count`, row.visitorCount, "visitors"],
          [`${grain}.national_share_pct`, row.nationalSharePct ?? row.provinceNationalSharePct, "percent"],
          [`${grain}.local_within_province_share_pct`, row.localWithinProvinceSharePct, "percent"]
        ];
        for (const [metricCode, value, unit] of values) {
          const numericValue = numberOrNull(value);
          if (numericValue === null) {
            recordImportLedger(database, {
              sourceArtifactId: artifactId,
              legacyRecordKey: `${grain}:${row.historicalRegionKey || row.currentRegionKey || row.regionKey}:${metricCode}:${start}:${end}`,
              targetTable: "region_metric_observations",
              importStatus: "skipped",
              reason: "null_metric_value"
            });
            continue;
          }
          const imported = upsertRegionMetric(database, {
            runId,
            regionId,
            sourceId: "kto_datalab_download",
            metricCode,
            periodStart: start,
            periodEnd: end,
            valueNum: numericValue,
            unit,
            status,
            collectedAt,
            sourceArtifactId: artifactId,
            qualityScore,
            raw: redactSensitive({ grain, ...row })
          });
          recordImportLedger(database, {
            sourceArtifactId: artifactId,
            legacyRecordKey: `${grain}:${row.historicalRegionKey || row.currentRegionKey || row.regionKey}:${metricCode}:${start}:${end}`,
            targetTable: "region_metric_observations",
            targetRecordId: imported.observationId
          });
          metricCount += 1;
        }
      }
    }
    for (const row of (document.nationalMonthlyTrend || [])) {
      const range = monthRange(row.yearMonth);
      for (const [metricCode, value] of [
        ["visitor_non_resident", row.nonResidentVisitors],
        ["visitor_total", row.totalVisitors],
        ["visitor_resident", row.residentVisitors]
      ]) {
        const numericValue = numberOrNull(value);
        if (numericValue === null) {
          recordImportLedger(database, {
            sourceArtifactId: artifactId,
            legacyRecordKey: `national:${row.yearMonth}:${metricCode}`,
            targetTable: "region_metric_observations",
            importStatus: "skipped",
            reason: "null_metric_value"
          });
          continue;
        }
        const imported = upsertRegionMetric(database, {
          runId,
          regionId: "kr_national",
          sourceId: "kto_datalab_download",
          metricCode,
          periodStart: range.start,
          periodEnd: range.end,
          valueNum: numericValue,
          unit: "visitors",
          status,
          collectedAt,
          sourceArtifactId: artifactId,
          qualityScore,
          raw: redactSensitive(row)
        });
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `national:${row.yearMonth}:${metricCode}`,
          targetTable: "region_metric_observations",
          targetRecordId: imported.observationId
        });
        metricCount += 1;
      }
    }
  }
  return { files: files.length, metrics: metricCount };
}

function tourismSourceFromSnapshot(snapshot, filePath) {
  const adapter = cleanText(snapshot.adapter).toLowerCase();
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (adapter === "locgo-regn-visitors-v1") return "kto_visitor_api";
  if (adapter === "area-tar-dem-ds-v1") return "kto_demand_strength_api";
  if (adapter === "area-tar-res-dem-v3") return "kto_resource_demand_api";
  if (adapter === "area-tar-div-v3") return "kto_tourism_diversity_api";
  // Historical snapshots used descriptive adapter names before versions were fixed.
  if (adapter.includes("demand-strength") || normalized.includes("demand_strength") || normalized.includes("demand-strength")) return "kto_demand_strength_api";
  if (adapter.includes("resource") || adapter.includes("res-dem") || normalized.includes("resource_demand") || normalized.includes("resource-demand")) return "kto_resource_demand_api";
  if (adapter.includes("diversity") || normalized.includes("diversity")) return "kto_tourism_diversity_api";
  if (adapter.includes("visitor") || adapter.includes("locgo-regn") || normalized.includes("visitor")) return "kto_visitor_api";
  return null;
}

function metricStatus(snapshotStatus, value, childStatus = "") {
  const normalizedStatuses = [snapshotStatus, childStatus]
    .filter((status) => cleanText(status))
    .map(normalizeStatus);
  const normalized = normalizedStatuses.length
    ? normalizedStatuses.reduce((lowest, status) => statusRank(status) < statusRank(lowest) ? status : lowest, "complete")
    : "pending";
  if (normalized !== "complete") return normalized;
  return numberOrNull(value) !== null ? "complete" : "partial";
}

function importTourismCacheFile(database, filePath, dataDir, lookup, options = {}) {
  let metricCount = 0;
  const fallbackSourceId = sourceIdForFile(filePath);
  let snapshot;
  try {
    snapshot = readJson(filePath);
  } catch (error) {
    const artifactId = registerArtifact(database, filePath, dataDir, null, fallbackSourceId);
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: "file:parse",
      targetTable: "region_metric_observations",
      importStatus: "rejected",
      reason: `invalid_json:${cleanText(error.message)}`
    });
    return { filePath, sourceId: fallbackSourceId, artifactId, runId: null, regionId: null, status: "rejected", reason: "invalid_json", metrics: 0 };
  }
  const sourceId = tourismSourceFromSnapshot(snapshot, filePath);
  if (!sourceId) {
    const artifactId = registerArtifact(database, filePath, dataDir, null, fallbackSourceId);
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: "file:source",
      targetTable: "region_metric_observations",
      importStatus: "rejected",
      reason: "unknown_tourism_source"
    });
    return { filePath, sourceId: fallbackSourceId, artifactId, runId: null, regionId: null, status: "rejected", reason: "unknown_tourism_source", metrics: 0 };
  }
  const artifactId = registerArtifact(database, filePath, dataDir, null, sourceId);
  const range = monthRange(snapshot.yearMonth);
  if (!range.start || !range.end) {
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: "file:period",
      targetTable: "region_metric_observations",
      importStatus: "rejected",
      reason: "invalid_year_month"
    });
    return { filePath, sourceId, artifactId, runId: null, regionId: null, status: "rejected", reason: "invalid_year_month", metrics: 0 };
  }
  const collectedAt = deterministicFileTime(filePath, snapshot.collectedAt);
  const evidenceHash = database.prepare("SELECT sha256 FROM source_artifacts WHERE artifact_id = ?").get(artifactId)?.sha256 || "";
  const runId = stableId("run", sourceId, snapshot.yearMonth, snapshot.region?.regionKey || "all", evidenceHash || artifactId);
  insertCollectionRun(database, {
    runId,
    sourceId,
    runLabel: `${sourceId} ${snapshot.yearMonth}`,
    periodStart: range.start,
    periodEnd: range.end,
    completedAt: collectedAt,
    status: snapshot.status,
    artifactId,
    raw: {
      schemaVersion: snapshot.schemaVersion,
      adapter: snapshot.adapter,
      regionMapVersion: snapshot.regionMapVersion,
      status: snapshot.status,
      reason: snapshot.reason,
      yearMonth: snapshot.yearMonth,
      region: snapshot.region || null,
      quality: snapshot.quality || null,
      collection: snapshot.collection || null,
      source: snapshot.source || null,
      sourceArtifactId: artifactId
    }
  });
  database.prepare("UPDATE source_artifacts SET run_id = ? WHERE artifact_id = ?").run(runId, artifactId);
  if (Array.isArray(snapshot.allRegions)) {
    for (const row of snapshot.allRegions) {
      const rowDecision = typeof options.validateRegionRow === "function"
        ? options.validateRegionRow(row, snapshot)
        : null;
      const regionId = resolveRegionId(row.regionKey, lookup);
      if (!regionId) {
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `${cleanText(row.regionKey) || "unknown"}:${snapshot.yearMonth}:region`,
          targetTable: "region_metric_observations",
          importStatus: "skipped",
          reason: "unmatched_region"
        });
        continue;
      }
      const values = [
        ["visitor_days", row.visitorDays, "visitors"],
        ["visitor_average_daily", row.averageDailyVisitors, "visitors/day"],
        ["visitor_coverage_rate", row.coverageRate, "ratio"],
        ["visitor_observed_days", row.observedDays, "days"]
      ];
      for (const [metricCode, value, unit] of values) {
        const numericValue = numberOrNull(value);
        const status = rowDecision?.status
          ? normalizeStatus(rowDecision.status)
          : metricStatus(snapshot.status, value, row.quality?.status);
        const imported = upsertRegionMetric(database, {
          runId,
          regionId,
          sourceId,
          metricCode,
          periodStart: range.start,
          periodEnd: range.end,
          valueNum: numericValue,
          unit,
          status,
          collectedAt,
          sourceArtifactId: artifactId,
          qualityScore: numberOrNull(rowDecision?.qualityScore),
          promoteCurrent: rowDecision ? rowDecision.promoteCurrent !== false : status === "complete",
          raw: redactSensitive({ ...row, masterDbValidationReasons: rowDecision?.reasons || [] })
        });
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `${row.regionKey}:${snapshot.yearMonth}:${metricCode}`,
          targetTable: "region_metric_observations",
          targetRecordId: imported.observationId
        });
        metricCount += 1;
      }
      for (const [category, value] of Object.entries(row.categoryVisitorDays || {})) {
        const numericValue = numberOrNull(value);
        const status = rowDecision?.status
          ? normalizeStatus(rowDecision.status)
          : metricStatus(snapshot.status, value, row.quality?.status);
        const imported = upsertRegionMetric(database, {
          runId,
          regionId,
          sourceId,
          metricCode: `visitor_category_${category}`,
          periodStart: range.start,
          periodEnd: range.end,
          valueNum: numericValue,
          unit: "visitors",
          status,
          collectedAt,
          sourceArtifactId: artifactId,
          qualityScore: numberOrNull(rowDecision?.qualityScore),
          promoteCurrent: rowDecision ? rowDecision.promoteCurrent !== false : status === "complete",
          raw: redactSensitive({ ...row, masterDbValidationReasons: rowDecision?.reasons || [] })
        });
        recordImportLedger(database, {
          sourceArtifactId: artifactId,
          legacyRecordKey: `${row.regionKey}:${snapshot.yearMonth}:visitor_category_${category}`,
          targetTable: "region_metric_observations",
          targetRecordId: imported.observationId
        });
        metricCount += 1;
      }
    }
    return { filePath, sourceId, artifactId, runId, regionId: null, status: normalizeStatus(snapshot.status), reason: snapshot.reason || "", range, collectedAt, metrics: metricCount };
  }
  const regionId = resolveRegionId(snapshot.region?.regionKey, lookup);
  if (!regionId) {
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: `${cleanText(snapshot.region?.regionKey) || "unknown"}:${snapshot.yearMonth}:region`,
      targetTable: "region_metric_observations",
      importStatus: "skipped",
      reason: "unmatched_region"
    });
    return { filePath, sourceId, artifactId, runId, regionId: null, status: "partial", reason: "unmatched_region", range, collectedAt, metrics: 0 };
  }
  if (!snapshot.operations || typeof snapshot.operations !== "object") {
    recordImportLedger(database, {
      sourceArtifactId: artifactId,
      legacyRecordKey: `${regionId}:${snapshot.yearMonth}:operations`,
      targetTable: "region_metric_observations",
      importStatus: "skipped",
      reason: "missing_operations"
    });
    return { filePath, sourceId, artifactId, runId, regionId, status: "partial", reason: "missing_operations", range, collectedAt, metrics: 0 };
  }
  for (const [operationKey, operation] of Object.entries(snapshot.operations)) {
    const metrics = Array.isArray(operation?.metrics) ? [...operation.metrics] : [];
    if (!metrics.length && operation && Object.hasOwn(operation, "overallValue")) {
      metrics.push({ code: operation.overallCode || "overall", value: operation.overallValue, label: operation.label || operationKey });
    }
    for (const metric of metrics) {
      const value = metric?.value;
      const numericValue = numberOrNull(value);
      const metricCode = `${operationKey}.${cleanText(metric?.code || metric?.label || "unknown")}`;
      const status = metricStatus(snapshot.status, value, operation?.status);
      const imported = upsertRegionMetric(database, {
        runId,
        regionId,
        sourceId,
        metricCode,
        periodStart: range.start,
        periodEnd: range.end,
        valueNum: numericValue,
        valueText: numericValue === null && value !== null && value !== undefined && cleanText(value) ? cleanText(value) : null,
        unit: "index",
        status,
        collectedAt,
        sourceArtifactId: artifactId,
        promoteCurrent: status === "complete",
        raw: redactSensitive({
          operationKey,
          operationStatus: operation?.status || null,
          operationReason: operation?.reason || null,
          metric,
          sourceArtifactId: artifactId
        })
      });
      recordImportLedger(database, {
        sourceArtifactId: artifactId,
        legacyRecordKey: `${snapshot.region?.regionKey}:${snapshot.yearMonth}:${metricCode}`,
        targetTable: "region_metric_observations",
        targetRecordId: imported.observationId
      });
      metricCount += 1;
    }
  }
  return { filePath, sourceId, artifactId, runId, regionId, status: normalizeStatus(snapshot.status), reason: snapshot.reason || "", range, collectedAt, metrics: metricCount };
}

function importTourismCache(database, dataDir, lookup) {
  const directory = path.join(dataDir, "tourism_data", "cache");
  const files = listFilesRecursive(directory, (filePath) => filePath.toLowerCase().endsWith(".json"));
  let metricCount = 0;
  for (const filePath of files) {
    metricCount += importTourismCacheFile(database, filePath, dataDir, lookup).metrics;
  }
  return { files: files.length, metrics: metricCount };
}

function databaseCounts(database) {
  const tables = [
    "data_sources",
    "business_categories",
    "administrative_regions",
    "region_aliases",
    "tourism_region_codes",
    "companies",
    "company_aliases",
    "company_external_ids",
    "company_match_candidates",
    "company_regions",
    "company_addresses",
    "company_urls",
    "keywords",
    "collection_runs",
    "collection_tasks",
    "collection_attempts",
    "source_artifacts",
    "legacy_import_ledger",
    "company_snapshots",
    "company_snapshot_pointers",
    "company_channel_settings",
    "company_channel_setting_current",
    "company_product_observations",
    "collection_receipts",
    "company_observations",
    "company_observation_current",
    "region_metric_observations",
    "region_metric_current",
    "keyword_metric_observations",
    "keyword_metric_current",
    "derived_metric_observations",
    "reference_records",
    "manual_overrides",
    "quality_reviews",
    "internal_actuals",
    "ops_job_runs"
  ];
  return Object.fromEntries(tables.map((table) => [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}

function applyImport(options) {
  const sourceFiles = collectSourceFiles(options.dataDir);
  const database = openMasterDatabase(options.databasePath);
  try {
    const result = withTransaction(database, () => {
      const schema = applySchema(database);
      seedReferenceTables(database);
      const artifactByName = new Map();
      for (const filePath of sourceFiles) {
        artifactByName.set(path.resolve(filePath), registerArtifact(database, filePath, options.dataDir));
      }
      const fileNamed = (name) => sourceFiles.find((filePath) => path.basename(filePath).toLowerCase() === name);
      const regionFile = fileNamed("region_master.json");
      const tourismMapFile = fileNamed("tourism_region_map.json");
      const locationFile = fileNamed("location_dictionary.json");
      const companyFile = fileNamed("companies.json");
      const historyFile = fileNamed("observations.jsonl");
      const datalabTrendFile = fileNamed("datalab_trends.json");
      const crawlTimingFile = fileNamed("crawl_timings.json");
      const locationRequestFile = fileNamed("location_card_requests.json");
      const locationOverrideFile = fileNamed("location_score_overrides.json");
      const importedRegions = importRegions(database, regionFile, artifactByName.get(path.resolve(regionFile || "")) || null);
      let lookup = regionLookup(database);
      const importedTourismMappings = importTourismRegionMap(
        database,
        tourismMapFile,
        artifactByName.get(path.resolve(tourismMapFile || "")) || null,
        lookup
      );
      lookup = regionLookup(database);
      const importedReferences = importReferenceRecords(
        database,
        locationFile,
        artifactByName.get(path.resolve(locationFile || "")) || null,
        lookup
      );
      const importedRuns = importRunManifests(database, options.dataDir, lookup);
      const importedCompanies = importCompanies(
        database,
        companyFile,
        artifactByName.get(path.resolve(companyFile || "")) || null,
        lookup
      );
      const importedHistory = importHistoryObservations(
        database,
        historyFile,
        artifactByName.get(path.resolve(historyFile || "")) || null
      );
      const importedKeywordMetrics = importTrafficMetrics(database, options.dataDir);
      const importedDatalabTrendPoints = importDatalabTrends(
        database,
        datalabTrendFile,
        artifactByName.get(path.resolve(datalabTrendFile || "")) || null
      );
      const importedCrawlTimings = importCrawlTimings(
        database,
        crawlTimingFile,
        artifactByName.get(path.resolve(crawlTimingFile || "")) || null
      );
      const importedSafeAdminConfigs = [locationRequestFile, locationOverrideFile]
        .filter(Boolean)
        .reduce((sum, filePath) => sum + importSafeAdminConfig(
          database,
          filePath,
          artifactByName.get(path.resolve(filePath)) || null
        ), 0);
      const period = importTourismPeriodSummaries(database, options.dataDir, lookup);
      const cache = importTourismCache(database, options.dataDir, lookup);
      database.prepare(`
        INSERT INTO master_meta (meta_key, meta_value, updated_at)
        VALUES ('last_import_at', ?, ?)
        ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at
      `).run(nowIso(), nowIso());
      return {
        mode: "apply",
        databasePath: options.databasePath,
        existingFilesChanged: false,
        credentialsIncluded: false,
        schema,
        processed: {
          artifacts: sourceFiles.length,
          regions: importedRegions,
          tourismRegionMappings: importedTourismMappings,
          referenceRecords: importedReferences,
          companies: importedCompanies,
          runs: importedRuns,
          historyObservations: importedHistory,
          keywordMetricRows: importedKeywordMetrics,
          datalabTrendPoints: importedDatalabTrendPoints,
          crawlTimingRows: importedCrawlTimings,
          safeAdminConfigFiles: importedSafeAdminConfigs,
          tourismPeriodFiles: period.files,
          tourismPeriodMetrics: period.metrics,
          tourismCacheFiles: cache.files,
          tourismCacheMetrics: cache.metrics
        },
        counts: databaseCounts(database)
      };
    });
    return result;
  } finally {
    database.close();
  }
}

function formatReport(report) {
  if (report.mode === "dry-run") {
    return [
      "마스터 DB 반입 사전검사 완료",
      `- 원본 파일: ${report.files}개 (${report.bytes.toLocaleString("ko-KR")} bytes)`,
      `- 행정구역: ${report.regions}개`,
      `- 관광 API 지역매핑: ${report.tourismRegionMappings}개`,
      `- 업체: ${report.companies}개`,
      `- 업체 관측: ${report.historyObservations}건`,
      `- 수집 회차 manifest: ${report.manifests}개`,
      `- 키워드 지표: ${report.keywordMetrics}건`,
      `- 관광 12개월 파일: ${report.tourismPeriodSummaries}개`,
      `- 관광 월별 cache: ${report.tourismCacheSnapshots}개`,
      `- 파싱 오류: ${report.parseErrors.length}건`,
      "- 기존 파일 변경: 없음",
      "- 로그인·API 키 반입: 안 함",
      "실제 Shadow DB 생성은 --apply를 명시해야 실행됩니다."
    ].join("\n");
  }
  return [
    "마스터 DB Shadow 반입 완료",
    `- DB: ${report.databasePath}`,
    `- 원본 파일 변경: ${report.existingFilesChanged ? "있음" : "없음"}`,
    `- 업체: ${report.counts.companies}개`,
    `- 업체 관측: ${report.counts.company_observations}건`,
    `- 행정구역: ${report.counts.administrative_regions}개`,
    `- 관광 지역매핑: ${report.counts.tourism_region_codes}개`,
    `- 지역 지표: ${report.counts.region_metric_observations}건`,
    `- 키워드 지표: ${report.counts.keyword_metric_observations}건`,
    `- 증거파일 색인: ${report.counts.source_artifacts}개`,
    "기존 화면의 읽기·쓰기는 아직 변경하지 않았습니다."
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const report = options.apply ? applyImport(options) : inspectInputs(options.dataDir);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.parseErrors?.length) return 2;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`마스터 DB 작업 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SOURCE_DEFINITIONS,
  CATEGORY_DEFINITIONS,
  redactSensitiveText,
  redactSensitive,
  parseArguments,
  usage,
  readJson,
  readJsonLines,
  listFilesRecursive,
  collectSourceFiles,
  relativeArtifactPath,
  manifestFileName,
  manifestListedFileNames,
  manifestCompletedAt,
  inspectInputs,
  seedReferenceTables,
  registerArtifact,
  recordImportLedger,
  importRegions,
  regionLookup,
  resolveRegionId,
  importTourismRegionMap,
  importReferenceRecords,
  inferCategory,
  ensureKeyword,
  observationCompanyId,
  ensureCompany,
  ensureRunForObservation,
  storeCompanyExternalIdentity,
  importCompanies,
  importRunManifests,
  importHistoryObservationRows,
  importHistoryObservations,
  importTrafficMetrics,
  importDatalabTrends,
  importCrawlTimings,
  importSafeAdminConfig,
  monthRange,
  insertCollectionRun,
  tourismSourceFromSnapshot,
  metricStatus,
  importTourismPeriodSummaries,
  importTourismCacheFile,
  importTourismCache,
  databaseCounts,
  applyImport,
  formatReport,
  main
};
