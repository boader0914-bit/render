const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  ROOT,
  SCHEMA_FILE,
  cleanText,
  numberOrNull,
  parsePrice,
  sha256Buffer,
  sha256File,
  openMasterDatabase,
  applySchema
} = require("./master_db.cjs");
const {
  collectSourceFiles,
  relativeArtifactPath,
  inspectInputs,
  applyImport,
  readJson,
  readJsonLines,
  observationCompanyId,
  tourismSourceFromSnapshot,
  monthRange,
  metricStatus
} = require("./master_db_import.cjs");
const { validateCompanyObservation } = require("./master_db_quality.cjs");

const AUDIT_SCHEMA_VERSION = "master-db-baseline-audit-v1";
const DEFAULT_COMPANY_ID = "cmp_place_35644668";
const DEFAULT_REGION_KEY = "kr_gyeongnam_sancheong";
const DEFAULT_REGION_ID = "kr_admin_4886000000";
const REQUIRED_REGION_SOURCE_IDS = Object.freeze([
  "kto_visitor_api",
  "kto_demand_strength_api",
  "kto_resource_demand_api",
  "kto_tourism_diversity_api"
]);
const LEDGER_TARGET_PRIMARY_KEYS = Object.freeze({
  source_artifacts: "artifact_id",
  companies: "company_id",
  company_observations: "observation_id",
  company_snapshots: "snapshot_id",
  keyword_metric_observations: "observation_id",
  region_metric_observations: "observation_id"
});
const LEDGER_ALLOWED_COMBINATIONS = Object.freeze([
  { status: "imported", reason: "", targetTables: Object.keys(LEDGER_TARGET_PRIMARY_KEYS), targetRequired: true },
  { status: "imported", reason: "unchanged_file_reused", targetTables: ["source_artifacts"], targetRequired: true },
  { status: "skipped", reason: "null_metric_value", targetTables: ["region_metric_observations"], targetRequired: false },
  { status: "review_required", reason: "low_confidence", targetTables: ["company_snapshots"], targetRequired: true },
  { status: "review_required", reason: "missing_content_receipt", targetTables: ["company_snapshots"], targetRequired: true }
]);

function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    dataDir: path.resolve(process.env.DATA_DIR || ROOT),
    databasePath: "",
    reportPath: "",
    keepDatabase: false,
    json: false,
    help: false
  };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 뒤에 경로가 필요합니다.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") options.dataDir = path.resolve(valueAfter(index++, argument));
    else if (argument === "--db") options.databasePath = path.resolve(valueAfter(index++, argument));
    else if (argument === "--report") options.reportPath = path.resolve(valueAfter(index++, argument));
    else if (argument === "--keep-db") options.keepDatabase = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`알 수 없는 옵션입니다: ${argument}`);
  }
  return options;
}

function usage() {
  return [
    "사용법:",
    "  node scripts/master_db_baseline_audit.cjs --data-dir PATH [--db PATH] [--report PATH] [--keep-db] [--json]",
    "",
    "운영 /var/data는 기본 차단됩니다. 쓰기가 중지된 복제본을 --data-dir로 지정하세요.",
    "감사 DB는 원본 폴더 밖의 새 경로만 허용하며 기존 DB를 덮어쓰지 않습니다."
  ].join("\n");
}

function canonicalPath(candidatePath, seenLinks = new Set()) {
  const absolute = path.resolve(candidatePath);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(current, segments[index]);
    let stats;
    try {
      stats = fs.lstatSync(next);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      return path.resolve(next, ...segments.slice(index + 1));
    }
    if (!stats.isSymbolicLink()) {
      current = next;
      continue;
    }
    const linkKey = path.resolve(next).toLowerCase();
    if (seenLinks.has(linkKey)) {
      const error = new Error(`순환 링크 경로는 감사에 사용할 수 없습니다: ${next}`);
      error.code = "baseline_circular_link_path";
      throw error;
    }
    const nextSeenLinks = new Set(seenLinks);
    nextSeenLinks.add(linkKey);
    const linkTarget = fs.readlinkSync(next);
    const resolvedTarget = path.resolve(path.dirname(next), linkTarget);
    return canonicalPath(path.join(resolvedTarget, ...segments.slice(index + 1)), nextSeenLinks);
  }
  try {
    return fs.realpathSync.native(current);
  } catch {
    return path.resolve(current);
  }
}

function isPathInside(basePath, candidatePath) {
  const relative = path.relative(canonicalPath(basePath), canonicalPath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseLinuxMountInfo(text = "") {
  const decode = (value) => String(value || "").replace(/\\([0-7]{3})/g, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
  return String(text || "").split(/\r?\n/).map((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) return null;
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6) return null;
    return {
      majorMinor: fields[2],
      root: decode(fields[3]),
      mountPoint: decode(fields[4])
    };
  }).filter(Boolean);
}

function mountInfoPathInsideLiveDisk(candidatePath, mountInfoText = "") {
  const entries = parseLinuxMountInfo(mountInfoText);
  const liveMount = entries.find((entry) => entry.mountPoint === "/var/data");
  if (!liveMount) return false;
  const candidate = String(candidatePath || "").replace(/\\/g, "/");
  const candidateMount = entries
    .filter((entry) => candidate === entry.mountPoint || candidate.startsWith(`${entry.mountPoint.replace(/\/$/, "")}/`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  if (!candidateMount || candidateMount.majorMinor !== liveMount.majorMinor) return false;
  const relative = path.posix.relative(candidateMount.mountPoint, candidate);
  const internalPath = path.posix.resolve(candidateMount.root, relative);
  const liveRoot = path.posix.resolve(liveMount.root);
  const liveRelative = path.posix.relative(liveRoot, internalPath);
  return liveRelative === "" || (!liveRelative.startsWith("..") && !path.posix.isAbsolute(liveRelative));
}

function isLiveRenderPath(candidatePath) {
  const normalized = canonicalPath(candidatePath).replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized === "/var/data" || normalized.startsWith("/var/data/")) return true;
  if (!fs.existsSync("/var/data")) return false;
  if (process.platform === "linux" && fs.existsSync("/proc/self/mountinfo")) {
    const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
    if (mountInfoPathInsideLiveDisk(normalized, mountInfo)) return true;
  }
  const liveStats = fs.statSync("/var/data");
  let current = canonicalPath(candidatePath);
  while (true) {
    try {
      const stats = fs.statSync(current);
      if (stats.dev === liveStats.dev && stats.ino === liveStats.ino) return true;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function deploymentCommit(rootDir = ROOT, env = process.env) {
  const renderCommit = cleanText(env.RENDER_GIT_COMMIT);
  if (renderCommit) return renderCommit;
  try {
    return cleanText(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }));
  } catch {
    return "unknown";
  }
}

function sourceManifest(dataDir) {
  const files = collectSourceFiles(dataDir);
  const entries = files.map((filePath) => {
    const before = fs.statSync(filePath);
    const sha256 = sha256File(filePath);
    const after = fs.statSync(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      const error = new Error(`원본 파일이 해시 계산 중 변경되었습니다: ${relativeArtifactPath(filePath, dataDir)}`);
      error.code = "baseline_source_changed_during_hash";
      throw error;
    }
    return {
      filePath,
      relativePath: relativeArtifactPath(filePath, dataDir),
      bytes: after.size,
      modifiedAt: after.mtime.toISOString(),
      sha256
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, "ko"));
  const digestInput = entries
    .map((entry) => [entry.relativePath, entry.bytes, entry.modifiedAt, entry.sha256].join("\u001f"))
    .join("\n");
  return {
    fileCount: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: sha256Buffer(Buffer.from(digestInput)),
    entries
  };
}

function publicSourceManifest(manifest) {
  return {
    fileCount: manifest.fileCount,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    entries: manifest.entries.map(({ relativePath, bytes, modifiedAt, sha256 }) => ({
      relativePath,
      bytes,
      modifiedAt,
      sha256
    }))
  };
}

function manifestsMatch(left, right) {
  return left.fileCount === right.fileCount
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

function previousMonth(yearMonth) {
  if (!/^\d{6}$/.test(cleanText(yearMonth))) return "";
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  if (month < 1 || month > 12) return "";
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function expectedTrailingMonths(latestMonth, count = 12) {
  const months = [];
  let cursor = cleanText(latestMonth);
  while (cursor && months.length < count) {
    months.push(cursor);
    cursor = previousMonth(cursor);
  }
  return months;
}

function commonTrailingMonthWindow(monthsBySource, sourceIds = REQUIRED_REGION_SOURCE_IDS, count = 12) {
  const sourceMonthSets = sourceIds.map((sourceId) => new Set(monthsBySource[sourceId] || []));
  const commonMonths = sourceMonthSets.length
    ? sourceMonthSets.reduce((intersection, months) => new Set([...intersection].filter((month) => months.has(month))))
    : new Set();
  const latestCommonMonth = [...commonMonths].sort((left, right) => right.localeCompare(left))[0] || "";
  const months = expectedTrailingMonths(latestCommonMonth, count).sort();
  return {
    latestCommonMonth,
    months,
    missingBySource: Object.fromEntries(sourceIds.map((sourceId) => [
      sourceId,
      months.filter((month) => !sourceMonthSets[sourceIds.indexOf(sourceId)].has(month))
    ]))
  };
}

function latestClosedYearMonth(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(1);
  kst.setUTCMonth(kst.getUTCMonth() - 1);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function oldestAllowedRegionMonth(now = new Date(), maximumLagMonths = 1) {
  let month = latestClosedYearMonth(now);
  for (let index = 0; index < Math.max(0, Number(maximumLagMonths) || 0); index += 1) {
    month = previousMonth(month);
  }
  return month;
}

function databaseFileBytes(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((filePath) => fs.existsSync(filePath))
    .reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
}

function databaseLogicalDigest(database) {
  const hash = crypto.createHash("sha256");
  const excludedTables = new Set(["master_meta", "schema_migrations"]);
  const excludedColumns = new Set(["updated_at", "created_at", "imported_at", "ingested_at", "applied_at"]);
  const tables = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name).filter((name) => !excludedTables.has(name));
  for (const table of tables) {
    const escapedTable = String(table).replace(/"/g, '""');
    const columns = database.prepare(`PRAGMA table_info("${escapedTable}")`).all()
      .map((column) => column.name)
      .filter((column) => !excludedColumns.has(column)
        && !(table === "legacy_import_ledger" && column === "reason"));
    const escapedColumns = columns.map((column) => `"${String(column).replace(/"/g, '""')}"`);
    hash.update(`table:${table}\ncolumns:${columns.join("\u001f")}\n`);
    if (!columns.length) continue;
    const statement = database.prepare(`
      SELECT ${escapedColumns.join(", ")}
      FROM "${escapedTable}"
      ORDER BY ${escapedColumns.join(", ")}
    `);
    for (const row of statement.iterate()) {
      hash.update(`${JSON.stringify(columns.map((column) => row[column] ?? null))}\n`);
    }
  }
  return hash.digest("hex");
}

function freeBytes(directoryPath) {
  try {
    const stats = fs.statfsSync(directoryPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function measuredFreeBytes(directoryPath, provider = freeBytes) {
  try {
    const measured = provider(directoryPath);
    return typeof measured === "number" && Number.isFinite(measured) && measured >= 0
      ? measured
      : null;
  } catch {
    return null;
  }
}

function valuesEqual(expected, actual, tolerance = 1e-9) {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === "number") {
    return typeof actual === "number" && Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance;
  }
  return String(expected) === String(actual ?? "");
}

function compareCompanyReference(database, dataDir, companyId = DEFAULT_COMPANY_ID) {
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  if (!fs.existsSync(historyFile)) {
    return { status: "unavailable", companyId, sourceRows: 0, comparedRows: 0, mismatches: ["history_file_missing"] };
  }
  const observations = readJsonLines(historyFile)
    .filter((observation) => observationCompanyId(observation) === companyId);
  if (!observations.length) {
    return { status: "unavailable", companyId, sourceRows: 0, comparedRows: 0, mismatches: ["company_reference_missing"] };
  }
  const statement = database.prepare(`
    SELECT observation_id, run_id, company_id, collected_at, stay_date,
           lead_time_days, rank_value, supply, available, sold, sale_rate,
           price_num, status, confidence_grade, confidence_score
    FROM company_observations
    WHERE observation_id = ?
  `);
  const mismatches = [];
  for (const observation of observations) {
    const actual = statement.get(observation.observationId);
    if (!actual) {
      mismatches.push({ observationId: observation.observationId, reason: "db_row_missing" });
      continue;
    }
    const expected = {
      run_id: cleanText(observation.runId),
      company_id: companyId,
      collected_at: cleanText(observation.collectedAt),
      stay_date: cleanText(observation.stayDate) || null,
      lead_time_days: numberOrNull(observation.leadTimeDays),
      rank_value: numberOrNull(observation.rank),
      supply: numberOrNull(observation.supply),
      available: numberOrNull(observation.available),
      sold: numberOrNull(observation.sold),
      sale_rate: numberOrNull(observation.saleRate),
      price_num: parsePrice(observation.price),
      status: validateCompanyObservation(observation).status,
      confidence_grade: cleanText(observation.inventoryConfidenceGrade) || null,
      confidence_score: numberOrNull(observation.inventoryConfidenceScore)
    };
    const differences = Object.entries(expected)
      .filter(([field, value]) => !valuesEqual(value, actual[field]))
      .map(([field, value]) => ({ field, expected: value, actual: actual[field] }));
    if (differences.length) mismatches.push({ observationId: observation.observationId, differences });
  }
  return {
    status: mismatches.length ? "mismatch" : "pass",
    companyId,
    sourceRows: observations.length,
    comparedRows: observations.length - mismatches.filter((item) => item.reason === "db_row_missing").length,
    mismatches
  };
}

function expectedRegionalMetrics(snapshot, regionKey) {
  const result = [];
  if (Array.isArray(snapshot.allRegions)) {
    const row = snapshot.allRegions.find((item) => cleanText(item.regionKey) === regionKey);
    if (!row) return result;
    const values = [
      ["visitor_days", row.visitorDays],
      ["visitor_average_daily", row.averageDailyVisitors],
      ["visitor_coverage_rate", row.coverageRate],
      ["visitor_observed_days", row.observedDays]
    ];
    for (const [metricCode, value] of values) {
      result.push({ metricCode, value, status: metricStatus(snapshot.status, value, row.quality?.status) });
    }
    for (const [category, value] of Object.entries(row.categoryVisitorDays || {})) {
      result.push({
        metricCode: `visitor_category_${category}`,
        value,
        status: metricStatus(snapshot.status, value, row.quality?.status)
      });
    }
    return result;
  }
  if (cleanText(snapshot.region?.regionKey) !== regionKey) return result;
  for (const [operationKey, operation] of Object.entries(snapshot.operations || {})) {
    const metrics = Array.isArray(operation?.metrics) ? [...operation.metrics] : [];
    if (!metrics.length && operation && Object.hasOwn(operation, "overallValue")) {
      metrics.push({ code: operation.overallCode || "overall", value: operation.overallValue });
    }
    for (const metric of metrics) {
      result.push({
        metricCode: `${operationKey}.${cleanText(metric?.code || metric?.label || "unknown")}`,
        value: metric?.value,
        status: metricStatus(snapshot.status, metric?.value, operation?.status)
      });
    }
  }
  return result;
}

function regionalCoverageDefinition() {
  const document = readJson(path.join(ROOT, "web", "data", "tourism_region_map.json"));
  const rawRegionKeys = (document.regions || []).map((region) => cleanText(region.regionKey)).filter(Boolean);
  const allRegionKeys = [...new Set(rawRegionKeys)];
  const eligibleRegionKeys = (document.regions || []).filter((region) => {
    const provinceCode = cleanText(document.provinceAliases?.[region.sidoKey]?.ktoSidoCd);
    return /^\d{2}$/.test(provinceCode)
      && /^\d{5}$/.test(cleanText(region.ktoSggCd))
      && !cleanText(region.codeStatus);
  }).map((region) => cleanText(region.regionKey));
  return {
    rawRegionCount: rawRegionKeys.length,
    allRegionKeys,
    duplicateRegionKeys: setDifferences(allRegionKeys, rawRegionKeys).duplicates,
    eligibleRegionKeys: [...new Set(eligibleRegionKeys)]
  };
}

function setDifferences(expectedValues, actualValues) {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  return {
    missing: [...expected].filter((value) => !actual.has(value)).sort(),
    unexpected: [...actual].filter((value) => !expected.has(value)).sort(),
    duplicates: actualValues.filter((value, index) => actualValues.indexOf(value) !== index)
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort()
  };
}

function compareRegionReference(database, dataDir, options = {}) {
  const regionKey = cleanText(options.regionKey || DEFAULT_REGION_KEY);
  const regionId = cleanText(options.regionId || DEFAULT_REGION_ID);
  const cacheDir = path.join(dataDir, "tourism_data", "cache");
  const files = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(cacheDir, entry.name))
    : [];
  const allSnapshots = [];
  const snapshots = [];
  for (const filePath of files) {
    try {
      const snapshot = readJson(filePath);
      const sourceId = tourismSourceFromSnapshot(snapshot, filePath);
      const metrics = sourceId ? expectedRegionalMetrics(snapshot, regionKey) : [];
      if (sourceId && /^\d{6}$/.test(cleanText(snapshot.yearMonth))) {
        const item = { filePath, snapshot, sourceId, metrics };
        allSnapshots.push(item);
        if (metrics.length) snapshots.push(item);
      }
    } catch {
      // The dry-run parse error list is the authoritative failure for malformed cache files.
    }
  }
  if (!snapshots.length) {
    return {
      status: allSnapshots.length ? "mismatch" : "unavailable",
      regionKey,
      regionId,
      months: [],
      sourceFiles: allSnapshots.length,
      comparedMetrics: 0,
      mismatches: [allSnapshots.length ? "regional_reference_missing_from_existing_cache" : "regional_cache_reference_missing"]
    };
  }
  const monthsBySource = Object.fromEntries(REQUIRED_REGION_SOURCE_IDS.map((sourceId) => [
    sourceId,
    [...new Set(snapshots.filter((item) => item.sourceId === sourceId)
      .map((item) => cleanText(item.snapshot.yearMonth)))].sort((left, right) => right.localeCompare(left))
  ]));
  const commonWindow = commonTrailingMonthWindow(monthsBySource);
  const { latestCommonMonth, months } = commonWindow;
  const latestAllowedMonth = latestClosedYearMonth(options.now || new Date());
  const oldestAllowedMonth = oldestAllowedRegionMonth(options.now || new Date(), options.maximumLagMonths ?? 1);
  const coverageBySource = {};
  const selected = [];
  for (const sourceId of REQUIRED_REGION_SOURCE_IDS) {
    const sourceSnapshots = snapshots.filter((item) => item.sourceId === sourceId);
    const availableMonths = monthsBySource[sourceId];
    const missingMonths = commonWindow.missingBySource[sourceId];
    coverageBySource[sourceId] = {
      latestMonth: availableMonths[0] || "",
      expectedMonths: months,
      availableMonths: availableMonths.filter((month) => months.includes(month)),
      missingMonths,
      sourceFiles: sourceSnapshots.filter((item) => months.includes(cleanText(item.snapshot.yearMonth))).length
    };
    selected.push(...allSnapshots.filter((item) => (
      item.sourceId === sourceId
      && months.includes(cleanText(item.snapshot.yearMonth))
    )));
  }
  const mismatches = [];
  if (months.length !== 12) mismatches.push({ reason: "common_trailing_12_month_window_missing" });
  if (latestCommonMonth && (latestCommonMonth < oldestAllowedMonth || latestCommonMonth > latestAllowedMonth)) {
    mismatches.push({
      reason: "common_trailing_12_month_window_stale",
      latestCommonMonth,
      oldestAllowedMonth,
      latestAllowedMonth
    });
  }
  for (const [sourceId, coverage] of Object.entries(coverageBySource)) {
    if (!coverage.latestMonth) {
      mismatches.push({ sourceId, reason: "required_source_missing" });
    } else if (coverage.expectedMonths.length !== 12 || coverage.missingMonths.length) {
      mismatches.push({ sourceId, reason: "trailing_12_months_incomplete", missingMonths: coverage.missingMonths });
    }
  }
  const coverageDefinition = regionalCoverageDefinition();
  if (coverageDefinition.rawRegionCount !== 229
    || coverageDefinition.allRegionKeys.length !== 229
    || coverageDefinition.duplicateRegionKeys.length) {
    mismatches.push({
      reason: "tourism_region_map_region_set_invalid",
      expectedRegions: 229,
      rawRegions: coverageDefinition.rawRegionCount,
      uniqueRegions: coverageDefinition.allRegionKeys.length,
      duplicates: coverageDefinition.duplicateRegionKeys
    });
  }
  const nationalCoverage = {};
  for (const sourceId of REQUIRED_REGION_SOURCE_IDS) {
    nationalCoverage[sourceId] = {};
    for (const yearMonth of months) {
      const monthSnapshots = allSnapshots.filter((item) => (
        item.sourceId === sourceId && cleanText(item.snapshot.yearMonth) === yearMonth
      ));
      const actualRegionKeys = sourceId === "kto_visitor_api"
        ? monthSnapshots.flatMap((item) => (item.snapshot.allRegions || []).map((row) => cleanText(row.regionKey)).filter(Boolean))
        : monthSnapshots.map((item) => cleanText(item.snapshot.region?.regionKey)).filter(Boolean);
      const expectedRegionKeys = sourceId === "kto_visitor_api"
        ? coverageDefinition.allRegionKeys
        : coverageDefinition.eligibleRegionKeys;
      const difference = setDifferences(expectedRegionKeys, actualRegionKeys);
      nationalCoverage[sourceId][yearMonth] = {
        sourceFiles: monthSnapshots.length,
        expectedRegions: expectedRegionKeys.length,
        observedRegions: new Set(actualRegionKeys).size,
        ...difference
      };
      const expectedFileCount = sourceId === "kto_visitor_api" ? 1 : expectedRegionKeys.length;
      if (monthSnapshots.length !== expectedFileCount
        || difference.missing.length || difference.unexpected.length || difference.duplicates.length) {
        mismatches.push({ sourceId, yearMonth, reason: "national_region_coverage_incomplete", ...nationalCoverage[sourceId][yearMonth] });
      }
      const referenceFiles = monthSnapshots.filter((item) => item.metrics.length);
      if (referenceFiles.length !== 1) {
        mismatches.push({ sourceId, yearMonth, reason: "reference_snapshot_count_invalid", count: referenceFiles.length });
      }
    }
  }
  const regionIdByKey = new Map(database.prepare(`
    SELECT region_key, region_id
    FROM administrative_regions
  `).all().map((row) => [cleanText(row.region_key), cleanText(row.region_id)]));
  let comparedMetrics = 0;
  let expectedMetrics = 0;
  let databaseMetrics = 0;
  for (const item of selected) {
    const range = monthRange(item.snapshot.yearMonth);
    const relativePath = relativeArtifactPath(item.filePath, dataDir);
    const artifact = database.prepare(`
      SELECT artifact_id, source_id
      FROM source_artifacts
      WHERE relative_path = ? AND sha256 = ?
      ORDER BY ingested_at DESC
      LIMIT 1
    `).get(relativePath, sha256File(item.filePath));
    if (!artifact) {
      mismatches.push({ file: relativePath, reason: "source_artifact_missing" });
      continue;
    }
    if (artifact.source_id !== item.sourceId) {
      mismatches.push({ file: relativePath, reason: "source_artifact_source_mismatch", expected: item.sourceId, actual: artifact.source_id });
      continue;
    }
    const sourceRegions = Array.isArray(item.snapshot.allRegions)
      ? item.snapshot.allRegions.map((row) => ({
        regionKey: cleanText(row.regionKey),
        metrics: expectedRegionalMetrics({ ...item.snapshot, allRegions: [row] }, cleanText(row.regionKey))
      }))
      : [{
        regionKey: cleanText(item.snapshot.region?.regionKey),
        metrics: expectedRegionalMetrics(item.snapshot, cleanText(item.snapshot.region?.regionKey))
      }];
    const expectedRows = [];
    for (const sourceRegion of sourceRegions) {
      const expectedRegionId = regionIdByKey.get(sourceRegion.regionKey);
      if (!expectedRegionId) {
        mismatches.push({ file: relativePath, regionKey: sourceRegion.regionKey, reason: "source_region_not_in_master_db" });
        continue;
      }
      for (const metric of sourceRegion.metrics) {
        expectedRows.push({ ...metric, regionId: expectedRegionId, regionKey: sourceRegion.regionKey });
      }
    }
    const actualRows = database.prepare(`
      SELECT observation_id, region_id, metric_code, value_num, value_text, status
      FROM region_metric_observations
      WHERE source_id = ? AND period_start = ? AND period_end = ? AND source_artifact_id = ?
      ORDER BY region_id, metric_code, observation_id
    `).all(item.sourceId, range.start, range.end, artifact.artifact_id);
    expectedMetrics += expectedRows.length;
    databaseMetrics += actualRows.length;
    const expectedKeys = expectedRows.map((row) => `${row.regionId}\u001f${row.metricCode}`);
    const actualKeys = actualRows.map((row) => `${row.region_id}\u001f${row.metric_code}`);
    const metricSetDifference = setDifferences(expectedKeys, actualKeys);
    if (metricSetDifference.missing.length
      || metricSetDifference.unexpected.length
      || metricSetDifference.duplicates.length) {
      mismatches.push({
        file: relativePath,
        reason: "db_metric_set_mismatch",
        expectedCount: expectedRows.length,
        databaseCount: actualRows.length,
        ...metricSetDifference
      });
    }
    const actualByKey = new Map();
    for (const actual of actualRows) {
      const key = `${actual.region_id}\u001f${actual.metric_code}`;
      if (!actualByKey.has(key)) actualByKey.set(key, []);
      actualByKey.get(key).push(actual);
    }
    for (const expected of expectedRows) {
      const rows = actualByKey.get(`${expected.regionId}\u001f${expected.metricCode}`) || [];
      if (rows.length !== 1) {
        mismatches.push({
          file: relativePath,
          regionKey: expected.regionKey,
          metricCode: expected.metricCode,
          reason: rows.length ? "db_metric_duplicate" : "db_metric_missing",
          rowCount: rows.length
        });
        continue;
      }
      const actual = rows[0];
      const expectedNumber = numberOrNull(expected.value);
      const expectedText = expectedNumber === null && cleanText(expected.value) ? cleanText(expected.value) : null;
      const differences = [];
      if (!valuesEqual(expectedNumber, actual.value_num)) differences.push("value_num");
      if (!valuesEqual(expectedText, actual.value_text)) differences.push("value_text");
      if (!valuesEqual(expected.status, actual.status)) differences.push("status");
      if (differences.length) {
        mismatches.push({ file: relativePath, metricCode: expected.metricCode, reason: "value_mismatch", differences });
      } else {
        comparedMetrics += 1;
      }
      if (expected.status === "complete" && months.includes(cleanText(item.snapshot.yearMonth))) {
        const pointer = database.prepare(`
          SELECT observation_id
          FROM region_metric_current
          WHERE region_id = ? AND source_id = ? AND metric_code = ? AND period_start = ? AND period_end = ?
        `).get(expected.regionId, item.sourceId, expected.metricCode, range.start, range.end);
        if (pointer?.observation_id !== actual.observation_id) {
          mismatches.push({ file: relativePath, metricCode: expected.metricCode, reason: "current_pointer_mismatch" });
        }
      }
    }
  }
  return {
    status: mismatches.length ? "mismatch" : "pass",
    regionKey,
    regionId,
    months,
    freshness: { latestCommonMonth, oldestAllowedMonth, latestAllowedMonth },
    sourceFiles: selected.length,
    coverageBySource,
    nationalCoverage,
    comparedMetrics,
    expectedMetrics,
    databaseMetrics,
    mismatches
  };
}

function databaseAudit(database, sourceBefore, dataDir) {
  applySchema(database);
  const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  const companyCurrentInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM company_observation_current_values
    WHERE COALESCE(status, '') <> 'complete'
       OR confidence_grade IS NULL OR confidence_grade NOT IN ('A', 'B')
       OR confidence_score IS NULL OR confidence_score < 70
       OR supply IS NULL OR supply <= 0
       OR supply <> CAST(supply AS INTEGER)
       OR available IS NULL OR available < 0 OR available <> CAST(available AS INTEGER)
       OR sold IS NULL OR sold < 0 OR sold <> CAST(sold AS INTEGER)
       OR supply <> available + sold
       OR sale_rate IS NULL OR sale_rate < 0 OR sale_rate > 1
       OR ABS(sale_rate - sold * 1.0 / supply) > 0.011
       OR price_num IS NULL OR price_num <= 0
  `).get().count);
  const regionCurrentInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM region_metric_current_values
    WHERE COALESCE(status, '') <> 'complete'
       OR (value_num IS NULL AND NULLIF(TRIM(COALESCE(value_text, '')), '') IS NULL)
  `).get().count);
  const keywordCurrentInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM keyword_metric_current_values
    WHERE COALESCE(status, '') <> 'complete'
       OR (value_num IS NULL AND NULLIF(TRIM(COALESCE(value_text, '')), '') IS NULL)
  `).get().count);
  const companyCurrentRows = Number(database.prepare("SELECT COUNT(*) AS count FROM company_observation_current").get().count);
  const companyCurrentExpected = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT company_id, COALESCE(stay_date, '') AS stay_date, product_key, channel_code, inventory_group, source_id
      FROM company_observations
      WHERE status = 'complete'
        AND confidence_grade IN ('A', 'B') AND confidence_score >= 70
        AND supply > 0 AND supply = CAST(supply AS INTEGER)
        AND available >= 0 AND available = CAST(available AS INTEGER)
        AND sold >= 0 AND sold = CAST(sold AS INTEGER)
        AND supply = available + sold
        AND sale_rate BETWEEN 0 AND 1
        AND ABS(sale_rate - sold * 1.0 / supply) <= 0.011
        AND price_num > 0
      GROUP BY company_id, COALESCE(stay_date, ''), product_key, channel_code, inventory_group, source_id
    )
  `).get().count);
  const companyCurrentMissing = Number(database.prepare(`
    WITH expected AS (
      SELECT company_id, COALESCE(stay_date, '') AS stay_date, product_key, channel_code, inventory_group, source_id
      FROM company_observations
      WHERE status = 'complete'
        AND confidence_grade IN ('A', 'B') AND confidence_score >= 70
        AND supply > 0 AND supply = CAST(supply AS INTEGER)
        AND available >= 0 AND available = CAST(available AS INTEGER)
        AND sold >= 0 AND sold = CAST(sold AS INTEGER)
        AND supply = available + sold
        AND sale_rate BETWEEN 0 AND 1
        AND ABS(sale_rate - sold * 1.0 / supply) <= 0.011
        AND price_num > 0
      GROUP BY company_id, COALESCE(stay_date, ''), product_key, channel_code, inventory_group, source_id
    )
    SELECT COUNT(*) AS count
    FROM expected
    LEFT JOIN company_observation_current pointer
      ON pointer.company_id = expected.company_id
     AND pointer.stay_date = expected.stay_date
     AND pointer.product_key = expected.product_key
     AND pointer.channel_code = expected.channel_code
     AND pointer.inventory_group = expected.inventory_group
     AND pointer.source_id = expected.source_id
    WHERE pointer.observation_id IS NULL
  `).get().count);
  const regionCurrentRows = Number(database.prepare("SELECT COUNT(*) AS count FROM region_metric_current").get().count);
  const regionCurrentExpected = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT region_id, source_id, metric_code, period_start, period_end
      FROM region_metric_observations
      WHERE status = 'complete' AND (value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(value_text, '')), '') IS NOT NULL)
      GROUP BY region_id, source_id, metric_code, period_start, period_end
    )
  `).get().count);
  const regionCurrentMissing = Number(database.prepare(`
    WITH expected AS (
      SELECT region_id, source_id, metric_code, period_start, period_end
      FROM region_metric_observations
      WHERE status = 'complete' AND (value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(value_text, '')), '') IS NOT NULL)
      GROUP BY region_id, source_id, metric_code, period_start, period_end
    )
    SELECT COUNT(*) AS count
    FROM expected
    LEFT JOIN region_metric_current pointer
      ON pointer.region_id = expected.region_id
     AND pointer.source_id = expected.source_id
     AND pointer.metric_code = expected.metric_code
     AND pointer.period_start = expected.period_start
     AND pointer.period_end = expected.period_end
    WHERE pointer.observation_id IS NULL
  `).get().count);
  const keywordCurrentRows = Number(database.prepare("SELECT COUNT(*) AS count FROM keyword_metric_current").get().count);
  const keywordCurrentExpected = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT keyword_id, source_id, metric_code, period_start, period_end
      FROM keyword_metric_observations
      WHERE status = 'complete' AND (value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(value_text, '')), '') IS NOT NULL)
      GROUP BY keyword_id, source_id, metric_code, period_start, period_end
    )
  `).get().count);
  const keywordCurrentMissing = Number(database.prepare(`
    WITH expected AS (
      SELECT keyword_id, source_id, metric_code, period_start, period_end
      FROM keyword_metric_observations
      WHERE status = 'complete' AND (value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(value_text, '')), '') IS NOT NULL)
      GROUP BY keyword_id, source_id, metric_code, period_start, period_end
    )
    SELECT COUNT(*) AS count
    FROM expected
    LEFT JOIN keyword_metric_current pointer
      ON pointer.keyword_id = expected.keyword_id
     AND pointer.source_id = expected.source_id
     AND pointer.metric_code = expected.metric_code
     AND pointer.period_start = expected.period_start
     AND pointer.period_end = expected.period_end
    WHERE pointer.observation_id IS NULL
  `).get().count);
  const companyCurrentPointerInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM company_observation_current pointer
    JOIN company_observations observation ON observation.observation_id = pointer.observation_id
    WHERE pointer.company_id <> observation.company_id
       OR pointer.stay_date <> COALESCE(observation.stay_date, '')
       OR pointer.product_key <> observation.product_key
       OR pointer.channel_code <> observation.channel_code
       OR pointer.inventory_group <> observation.inventory_group
       OR pointer.source_id <> observation.source_id
       OR pointer.status_rank <> observation.status_rank
       OR pointer.has_value <> CASE WHEN observation.rank_value IS NOT NULL
                                      OR observation.supply IS NOT NULL
                                      OR observation.available IS NOT NULL
                                      OR observation.sold IS NOT NULL
                                      OR observation.sale_rate IS NOT NULL
                                      OR observation.price_num IS NOT NULL
                                      OR NULLIF(TRIM(COALESCE(observation.price_text, '')), '') IS NOT NULL
                                    THEN 1 ELSE 0 END
       OR pointer.collected_at <> observation.collected_at
       OR observation.status <> 'complete'
       OR observation.confidence_grade IS NULL OR observation.confidence_grade NOT IN ('A', 'B')
       OR observation.confidence_score IS NULL OR observation.confidence_score < 70
       OR observation.supply IS NULL OR observation.supply <= 0 OR observation.supply <> CAST(observation.supply AS INTEGER)
       OR observation.available IS NULL OR observation.available < 0 OR observation.available <> CAST(observation.available AS INTEGER)
       OR observation.sold IS NULL OR observation.sold < 0 OR observation.sold <> CAST(observation.sold AS INTEGER)
       OR observation.supply <> observation.available + observation.sold
       OR observation.sale_rate IS NULL OR observation.sale_rate NOT BETWEEN 0 AND 1
       OR ABS(observation.sale_rate - observation.sold * 1.0 / observation.supply) > 0.011
       OR observation.price_num IS NULL OR observation.price_num <= 0
       OR EXISTS (
         SELECT 1
         FROM company_observations newer
         WHERE newer.company_id = observation.company_id
           AND COALESCE(newer.stay_date, '') = COALESCE(observation.stay_date, '')
           AND newer.product_key = observation.product_key
           AND newer.channel_code = observation.channel_code
           AND newer.inventory_group = observation.inventory_group
           AND newer.source_id = observation.source_id
           AND newer.status = 'complete'
           AND newer.confidence_grade IN ('A', 'B') AND newer.confidence_score >= 70
           AND newer.supply > 0 AND newer.supply = CAST(newer.supply AS INTEGER)
           AND newer.available >= 0 AND newer.available = CAST(newer.available AS INTEGER)
           AND newer.sold >= 0 AND newer.sold = CAST(newer.sold AS INTEGER)
           AND newer.supply = newer.available + newer.sold
           AND newer.sale_rate BETWEEN 0 AND 1
           AND ABS(newer.sale_rate - newer.sold * 1.0 / newer.supply) <= 0.011
           AND newer.price_num > 0
           AND (
             newer.status_rank > observation.status_rank
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.rank_value IS NOT NULL
                          OR newer.supply IS NOT NULL OR newer.available IS NOT NULL OR newer.sold IS NOT NULL
                          OR newer.sale_rate IS NOT NULL OR newer.price_num IS NOT NULL
                          OR NULLIF(TRIM(COALESCE(newer.price_text, '')), '') IS NOT NULL
                        THEN 1 ELSE 0 END
                   > CASE WHEN observation.rank_value IS NOT NULL
                            OR observation.supply IS NOT NULL OR observation.available IS NOT NULL OR observation.sold IS NOT NULL
                            OR observation.sale_rate IS NOT NULL OR observation.price_num IS NOT NULL
                            OR NULLIF(TRIM(COALESCE(observation.price_text, '')), '') IS NOT NULL
                          THEN 1 ELSE 0 END
             )
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.rank_value IS NOT NULL
                          OR newer.supply IS NOT NULL OR newer.available IS NOT NULL OR newer.sold IS NOT NULL
                          OR newer.sale_rate IS NOT NULL OR newer.price_num IS NOT NULL
                          OR NULLIF(TRIM(COALESCE(newer.price_text, '')), '') IS NOT NULL
                        THEN 1 ELSE 0 END
                   = CASE WHEN observation.rank_value IS NOT NULL
                            OR observation.supply IS NOT NULL OR observation.available IS NOT NULL OR observation.sold IS NOT NULL
                            OR observation.sale_rate IS NOT NULL OR observation.price_num IS NOT NULL
                            OR NULLIF(TRIM(COALESCE(observation.price_text, '')), '') IS NOT NULL
                          THEN 1 ELSE 0 END
               AND newer.collected_at > observation.collected_at
             )
           )
       )
  `).get().count);
  const regionCurrentPointerInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM region_metric_current pointer
    JOIN region_metric_observations observation ON observation.observation_id = pointer.observation_id
    WHERE pointer.region_id <> observation.region_id
       OR pointer.source_id <> observation.source_id
       OR pointer.metric_code <> observation.metric_code
       OR pointer.period_start <> observation.period_start
       OR pointer.period_end <> observation.period_end
       OR pointer.status_rank <> observation.status_rank
       OR pointer.has_value <> CASE WHEN observation.value_num IS NOT NULL
                                      OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL
                                    THEN 1 ELSE 0 END
       OR pointer.collected_at <> observation.collected_at
       OR observation.status <> 'complete'
       OR (observation.value_num IS NULL AND NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NULL)
       OR EXISTS (
         SELECT 1
         FROM region_metric_observations newer
         WHERE newer.region_id = observation.region_id
           AND newer.source_id = observation.source_id
           AND newer.metric_code = observation.metric_code
           AND newer.period_start = observation.period_start
           AND newer.period_end = observation.period_end
           AND newer.status = 'complete'
           AND (newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL)
           AND (
             newer.status_rank > observation.status_rank
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
                   > CASE WHEN observation.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
             )
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
                   = CASE WHEN observation.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
               AND newer.collected_at > observation.collected_at
             )
           )
       )
  `).get().count);
  const keywordCurrentPointerInvalid = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM keyword_metric_current pointer
    JOIN keyword_metric_observations observation ON observation.observation_id = pointer.observation_id
    WHERE pointer.keyword_id <> observation.keyword_id
       OR pointer.source_id <> observation.source_id
       OR pointer.metric_code <> observation.metric_code
       OR pointer.period_start <> observation.period_start
       OR pointer.period_end <> observation.period_end
       OR pointer.status_rank <> observation.status_rank
       OR pointer.has_value <> CASE WHEN observation.value_num IS NOT NULL
                                      OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL
                                    THEN 1 ELSE 0 END
       OR pointer.collected_at <> observation.collected_at
       OR observation.status <> 'complete'
       OR (observation.value_num IS NULL AND NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NULL)
       OR EXISTS (
         SELECT 1
         FROM keyword_metric_observations newer
         WHERE newer.keyword_id = observation.keyword_id
           AND newer.source_id = observation.source_id
           AND newer.metric_code = observation.metric_code
           AND newer.period_start = observation.period_start
           AND newer.period_end = observation.period_end
           AND newer.status = 'complete'
           AND (newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL)
           AND (
             newer.status_rank > observation.status_rank
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
                   > CASE WHEN observation.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
             )
             OR (
               newer.status_rank = observation.status_rank
               AND CASE WHEN newer.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(newer.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
                   = CASE WHEN observation.value_num IS NOT NULL OR NULLIF(TRIM(COALESCE(observation.value_text, '')), '') IS NOT NULL THEN 1 ELSE 0 END
               AND newer.collected_at > observation.collected_at
             )
           )
       )
  `).get().count);
  const artifactRows = database.prepare("SELECT relative_path, sha256 FROM source_artifacts").all();
  const artifactKeys = new Set(artifactRows.map((row) => `${row.relative_path}\u001f${row.sha256}`));
  const missingArtifacts = sourceBefore.entries
    .filter((entry) => !artifactKeys.has(`${entry.relativePath}\u001f${entry.sha256}`))
    .map((entry) => entry.relativePath);
  const ledger = database.prepare(`
    SELECT import_status AS status, COALESCE(reason, '') AS reason, target_table, COUNT(*) AS count
    FROM legacy_import_ledger
    GROUP BY import_status, COALESCE(reason, ''), target_table
    ORDER BY import_status, reason, target_table
  `).all().map((row) => ({ ...row, count: Number(row.count) }));
  const ledgerDisposition = (row) => {
    if (!Object.hasOwn(LEDGER_TARGET_PRIMARY_KEYS, row.target_table)) return "fail";
    const allowed = LEDGER_ALLOWED_COMBINATIONS.find((combination) => (
      combination.status === row.status
      && combination.reason === row.reason
      && combination.targetTables.includes(row.target_table)
    ));
    if (!allowed) return "fail";
    if (row.status === "skipped") return "review_null";
    if (row.status === "review_required") return "review_deferred";
    return "pass";
  };
  const requiredTargetMissing = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM legacy_import_ledger ledger
    WHERE NULLIF(TRIM(COALESCE(target_record_id, '')), '') IS NULL
      AND NOT (
        ledger.import_status = 'skipped'
        AND COALESCE(ledger.reason, '') = 'null_metric_value'
        AND ledger.target_table = 'region_metric_observations'
      )
  `).get().count);
  const blockedLedgerStatusRows = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM legacy_import_ledger
    WHERE LOWER(TRIM(COALESCE(import_status, ''))) IN ('unknown', 'failed', 'error', 'rejected')
       OR LOWER(TRIM(COALESCE(import_status, ''))) NOT IN ('imported', 'skipped', 'review_required')
  `).get().count);
  const missingLedgerTargets = [];
  for (const [targetTable, primaryKey] of Object.entries(LEDGER_TARGET_PRIMARY_KEYS)) {
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM legacy_import_ledger ledger
      WHERE ledger.target_table = ?
        AND NULLIF(TRIM(COALESCE(ledger.target_record_id, '')), '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${targetTable} target WHERE target.${primaryKey} = ledger.target_record_id
        )
    `).get(targetTable);
    const count = Number(row.count);
    if (count) missingLedgerTargets.push({ targetTable, primaryKey, count });
  }
  return {
    integrity,
    foreignKeyFailures,
    quality: {
      companyCurrentRows,
      companyCurrentExpected,
      companyCurrentMissing,
      companyCurrentPointerInvalid,
      companyCurrentInvalid,
      regionCurrentRows,
      regionCurrentExpected,
      regionCurrentMissing,
      regionCurrentPointerInvalid,
      regionCurrentInvalid,
      keywordCurrentRows,
      keywordCurrentExpected,
      keywordCurrentMissing,
      keywordCurrentPointerInvalid,
      keywordCurrentInvalid
    },
    artifactCoverage: {
      expected: sourceBefore.fileCount,
      recorded: artifactRows.length,
      missing: missingArtifacts
    },
    ledger,
    rejectedLedgerRows: ledger
      .filter((row) => row.status === "rejected")
      .reduce((sum, row) => sum + row.count, 0),
    unsafeLedgerRows: ledger
      .filter((row) => ledgerDisposition(row) === "fail")
      .reduce((sum, row) => sum + row.count, 0),
    importedWithoutTarget: requiredTargetMissing,
    requiredTargetMissing,
    blockedLedgerStatusRows,
    missingLedgerTargets,
    missingLedgerTargetRows: missingLedgerTargets.reduce((sum, item) => sum + item.count, 0),
    knownNullOmissionRows: ledger
      .filter((row) => ledgerDisposition(row) === "review_null")
      .reduce((sum, row) => sum + row.count, 0),
    deferredReviewRows: ledger
      .filter((row) => ledgerDisposition(row) === "review_deferred")
      .reduce((sum, row) => sum + row.count, 0),
    references: {
      company: compareCompanyReference(database, dataDir),
      region: compareRegionReference(database, dataDir)
    }
  };
}

function addCheck(checks, name, passed, details, severity = "fail") {
  checks.push({ name, passed: Boolean(passed), severity, details });
}

function runAudit(input = {}) {
  const dataDir = path.resolve(input.dataDir || process.env.DATA_DIR || ROOT);
  const runtimeEnv = input.env || process.env;
  const freeBytesProvider = typeof input.freeBytesProvider === "function" ? input.freeBytesProvider : freeBytes;
  const masterDbWriteMode = String(runtimeEnv.MASTER_DB_WRITE_MODE || "off").trim().toLowerCase() || "off";
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    const error = new Error(`감사할 자료 폴더가 없습니다: ${dataDir}`);
    error.code = "baseline_data_dir_missing";
    throw error;
  }
  if (masterDbWriteMode !== "off") {
    const error = new Error(`Master DB 쓰기 모드가 off가 아니므로 baseline 감사를 실행할 수 없습니다: ${masterDbWriteMode}`);
    error.code = "baseline_write_mode_must_be_off";
    throw error;
  }
  if (isLiveRenderPath(dataDir)) {
    const error = new Error("운영 /var/data 직접 감사는 차단됩니다. 쓰기가 중지된 별도 복제본을 사용하세요.");
    error.code = "baseline_live_source_blocked";
    throw error;
  }
  if (cleanText(input.reportPath) && isPathInside(dataDir, path.resolve(input.reportPath))) {
    const error = new Error("감사 보고서는 원본 자료 폴더 밖에 저장해야 합니다.");
    error.code = "baseline_report_inside_source";
    throw error;
  }
  if (cleanText(input.reportPath) && isLiveRenderPath(input.reportPath)) {
    const error = new Error("운영 /var/data에는 감사 보고서를 저장할 수 없습니다.");
    error.code = "baseline_report_on_live_disk";
    throw error;
  }

  let temporaryDirectory = "";
  let databasePath = cleanText(input.databasePath) ? path.resolve(input.databasePath) : "";
  if (!databasePath) {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sabun-master-baseline-"));
    databasePath = path.join(temporaryDirectory, "sabun_master.sqlite");
  }
  if (isPathInside(dataDir, databasePath)) {
    const error = new Error("감사 DB는 원본 자료 폴더 밖에 생성해야 합니다.");
    error.code = "baseline_database_inside_source";
    throw error;
  }
  if (isLiveRenderPath(databasePath)) {
    const error = new Error("운영 /var/data에는 감사 DB를 생성할 수 없습니다.");
    error.code = "baseline_database_on_live_disk";
    throw error;
  }
  if (fs.existsSync(databasePath)) {
    const error = new Error(`기존 감사 DB를 덮어쓸 수 없습니다: ${databasePath}`);
    error.code = "baseline_database_exists";
    throw error;
  }
  try {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const freeBefore = measuredFreeBytes(path.dirname(databasePath), freeBytesProvider);
  const sourceBefore = sourceManifest(dataDir);
  const requiredFreeBefore = Math.max(16 * 1024 * 1024, sourceBefore.bytes * 2);
  if (freeBefore === null || freeBefore < requiredFreeBefore) {
    const error = new Error(`감사 DB 생성 전 여유공간이 부족하거나 측정할 수 없습니다. 필요 ${requiredFreeBefore}바이트, 확인 ${freeBefore ?? "불가"}바이트`);
    error.code = "baseline_insufficient_free_space";
    throw error;
  }
  const dryRun = inspectInputs(dataDir);
  const firstApply = applyImport({ dataDir, databasePath });
  const firstDigestDatabase = openMasterDatabase(databasePath);
  let firstLogicalDigest;
  try {
    firstLogicalDigest = databaseLogicalDigest(firstDigestDatabase);
  } finally {
    firstDigestDatabase.close();
  }
  if (typeof input.onAfterFirstApply === "function") input.onAfterFirstApply({ dataDir, databasePath });
  const secondApply = applyImport({ dataDir, databasePath });
  const sourceAfter = sourceManifest(dataDir);

  const database = openMasterDatabase(databasePath);
  let databaseChecks;
  let secondLogicalDigest;
  try {
    secondLogicalDigest = databaseLogicalDigest(database);
    databaseChecks = databaseAudit(database, sourceBefore, dataDir);
  } finally {
    database.close();
  }
  const databaseBytes = databaseFileBytes(databasePath);
  const freeAfter = measuredFreeBytes(path.dirname(databasePath), freeBytesProvider);
  const checks = [];
  addCheck(checks, "source_parse", dryRun.parseErrors.length === 0, { parseErrors: dryRun.parseErrors });
  addCheck(checks, "source_stable", manifestsMatch(sourceBefore, sourceAfter), {
    before: sourceBefore.sha256,
    after: sourceAfter.sha256
  });
  addCheck(checks, "apply_counts_stable", JSON.stringify(firstApply.counts) === JSON.stringify(secondApply.counts), {
    first: firstApply.counts,
    second: secondApply.counts
  });
  addCheck(checks, "logical_content_stable", firstLogicalDigest === secondLogicalDigest, {
    first: firstLogicalDigest,
    second: secondLogicalDigest
  });
  addCheck(checks, "artifact_count", firstApply.processed.artifacts === dryRun.files
    && firstApply.counts.source_artifacts === sourceBefore.fileCount, {
    dryRunFiles: dryRun.files,
    processedArtifacts: firstApply.processed.artifacts,
    sourceArtifacts: firstApply.counts.source_artifacts
  });
  addCheck(checks, "history_count", firstApply.counts.company_observations === dryRun.historyObservations, {
    source: dryRun.historyObservations,
    database: firstApply.counts.company_observations
  });
  const expectedRegionMetricRows = firstApply.processed.tourismPeriodMetrics
    + firstApply.processed.tourismCacheMetrics;
  addCheck(checks, "region_metric_count", firstApply.counts.region_metric_observations === expectedRegionMetricRows, {
    sourceExpected: expectedRegionMetricRows,
    periodSummaryMetrics: firstApply.processed.tourismPeriodMetrics,
    cacheMetrics: firstApply.processed.tourismCacheMetrics,
    database: firstApply.counts.region_metric_observations
  });
  const expectedKeywordMetricRows = firstApply.processed.keywordMetricRows * 10
    + firstApply.processed.datalabTrendPoints;
  addCheck(checks, "keyword_metric_count", firstApply.counts.keyword_metric_observations === expectedKeywordMetricRows, {
    sourceExpected: expectedKeywordMetricRows,
    searchAdKeywordRows: firstApply.processed.keywordMetricRows,
    metricsPerSearchAdKeyword: 10,
    datalabTrendPoints: firstApply.processed.datalabTrendPoints,
    database: firstApply.counts.keyword_metric_observations
  });
  addCheck(checks, "region_reference_count", firstApply.counts.administrative_regions === dryRun.regions + 1
    && firstApply.counts.tourism_region_codes === dryRun.tourismRegionMappings, {
    sourceRegions: dryRun.regions,
    databaseRegions: firstApply.counts.administrative_regions,
    sourceTourismMappings: dryRun.tourismRegionMappings,
    databaseTourismMappings: firstApply.counts.tourism_region_codes
  });
  addCheck(checks, "sqlite_integrity", databaseChecks.integrity.length === 1 && databaseChecks.integrity[0] === "ok", {
    results: databaseChecks.integrity
  });
  addCheck(checks, "foreign_keys", databaseChecks.foreignKeyFailures.length === 0, {
    failures: databaseChecks.foreignKeyFailures
  });
  addCheck(checks, "current_quality",
    databaseChecks.quality.companyCurrentRows === databaseChecks.quality.companyCurrentExpected
      && databaseChecks.quality.regionCurrentRows === databaseChecks.quality.regionCurrentExpected
      && databaseChecks.quality.keywordCurrentRows === databaseChecks.quality.keywordCurrentExpected
      && databaseChecks.quality.companyCurrentMissing === 0
      && databaseChecks.quality.regionCurrentMissing === 0
      && databaseChecks.quality.keywordCurrentMissing === 0
      && databaseChecks.quality.companyCurrentPointerInvalid === 0
      && databaseChecks.quality.regionCurrentPointerInvalid === 0
      && databaseChecks.quality.keywordCurrentPointerInvalid === 0
      && databaseChecks.quality.companyCurrentInvalid === 0
      && databaseChecks.quality.regionCurrentInvalid === 0
      && databaseChecks.quality.keywordCurrentInvalid === 0,
    databaseChecks.quality);
  addCheck(checks, "artifact_coverage", databaseChecks.artifactCoverage.missing.length === 0, databaseChecks.artifactCoverage);
  addCheck(checks, "ledger_safety",
    databaseChecks.rejectedLedgerRows === 0
      && databaseChecks.unsafeLedgerRows === 0
      && databaseChecks.requiredTargetMissing === 0
      && databaseChecks.blockedLedgerStatusRows === 0
      && databaseChecks.missingLedgerTargetRows === 0, {
      rejectedRows: databaseChecks.rejectedLedgerRows,
      unsafeRows: databaseChecks.unsafeLedgerRows,
      requiredTargetMissing: databaseChecks.requiredTargetMissing,
      blockedStatusRows: databaseChecks.blockedLedgerStatusRows,
      missingTargetRows: databaseChecks.missingLedgerTargetRows,
      missingTargets: databaseChecks.missingLedgerTargets
    });
  addCheck(checks, "known_null_omissions", databaseChecks.knownNullOmissionRows === 0, {
    rows: databaseChecks.knownNullOmissionRows,
    reason: "null_metric_value"
  }, "review");
  addCheck(checks, "deferred_legacy_reviews", databaseChecks.deferredReviewRows === 0, {
    rows: databaseChecks.deferredReviewRows,
    allowedReasons: ["low_confidence", "missing_content_receipt"]
  }, "review");
  addCheck(checks, "company_reference", databaseChecks.references.company.status === "pass", databaseChecks.references.company,
    databaseChecks.references.company.status === "unavailable" ? "review" : "fail");
  addCheck(checks, "region_reference", databaseChecks.references.region.status === "pass", databaseChecks.references.region,
    databaseChecks.references.region.status === "unavailable" ? "review" : "fail");
  addCheck(checks, "disk_headroom", freeAfter !== null && freeAfter >= databaseBytes * 2, {
    freeBefore,
    freeAfter,
    databaseBytes,
    requiredFreeBefore,
    requiredFreeAfter: databaseBytes * 2
  });

  const failed = checks.filter((check) => !check.passed && check.severity === "fail");
  const review = checks.filter((check) => !check.passed && check.severity === "review");
  const status = failed.length ? "fail" : review.length ? "review_required" : "pass";
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    status,
    generatedAt: new Date().toISOString(),
    deployment: {
      gitCommit: deploymentCommit(ROOT, runtimeEnv),
      schemaSha256: sha256File(SCHEMA_FILE),
      masterDbWriteMode
    },
    source: {
      dataDir,
      before: publicSourceManifest(sourceBefore),
      after: publicSourceManifest(sourceAfter),
      stable: manifestsMatch(sourceBefore, sourceAfter)
    },
    dryRun,
    firstApply,
    secondApply,
    idempotency: {
      firstLogicalDigest,
      secondLogicalDigest,
      stable: firstLogicalDigest === secondLogicalDigest
    },
    database: {
      path: databasePath,
      temporaryDirectory,
      bytes: databaseBytes,
      freeBytesBefore: freeBefore,
      freeBytesAfter: freeAfter,
      requiredFreeBytesBefore: requiredFreeBefore,
      ...databaseChecks
    },
    checks,
    failures: failed.map((check) => check.name),
    reviewRequired: review.map((check) => check.name),
    intentionallyDeferred: [
      "company_snapshot_pointers",
      "company_channel_setting_current",
      "company_product_observations",
      "keyword_specific_place_rank_current"
    ]
  };
  } catch (error) {
    if (temporaryDirectory) {
      const directory = path.resolve(temporaryDirectory);
      const tempRoot = path.resolve(os.tmpdir());
      if (isPathInside(tempRoot, directory) && path.basename(directory).startsWith("sabun-master-baseline-")) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function formatReport(report) {
  return [
    `Master DB baseline 감사: ${report.status}`,
    `- 배포 커밋: ${report.deployment.gitCommit}`,
    `- 원본 파일: ${report.source.before.fileCount}개 / 전후 SHA ${report.source.stable ? "일치" : "불일치"}`,
    `- SQLite 무결성: ${report.database.integrity.join(", ")}`,
    `- 외래키 오류: ${report.database.foreignKeyFailures.length}건`,
    `- 업체 current: ${report.database.quality.companyCurrentRows}/${report.database.quality.companyCurrentExpected}건 · 품질오류 ${report.database.quality.companyCurrentInvalid}건`,
    `- 지역 current: ${report.database.quality.regionCurrentRows}/${report.database.quality.regionCurrentExpected}건 · 품질오류 ${report.database.quality.regionCurrentInvalid}건`,
    `- 키워드 current: ${report.database.quality.keywordCurrentRows}/${report.database.quality.keywordCurrentExpected}건 · 품질오류 ${report.database.quality.keywordCurrentInvalid}건`,
    `- 월명글램핑 대조: ${report.database.references.company.status}`,
    `- 산청군 최근 12개월 대조: ${report.database.references.region.status}`,
    `- 실패 검사: ${report.failures.length ? report.failures.join(", ") : "없음"}`,
    `- 검토 필요: ${report.reviewRequired.length ? report.reviewRequired.join(", ") : "없음"}`,
    "이 도구는 기존 원본 파일과 운영 화면을 변경하지 않습니다."
  ].join("\n");
}

function cleanupTemporaryAudit(report, keepDatabase) {
  if (keepDatabase || !report?.database?.temporaryDirectory) return;
  const directory = path.resolve(report.database.temporaryDirectory);
  const tempRoot = path.resolve(os.tmpdir());
  if (!isPathInside(tempRoot, directory) || !path.basename(directory).startsWith("sabun-master-baseline-")) return;
  fs.rmSync(directory, { recursive: true, force: true });
  report.database.path = "";
  report.database.temporaryDirectory = "";
  report.database.retained = false;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const report = runAudit(options);
  const keepDatabase = options.keepDatabase || Boolean(options.databasePath);
  cleanupTemporaryAudit(report, keepDatabase);
  report.database.retained = keepDatabase;
  if (options.reportPath) {
    if (fs.existsSync(options.reportPath)) throw new Error(`기존 보고서를 덮어쓸 수 없습니다: ${options.reportPath}`);
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.status === "fail") return 1;
  if (report.status === "review_required") return 2;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Master DB baseline 감사 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  DEFAULT_COMPANY_ID,
  DEFAULT_REGION_KEY,
  DEFAULT_REGION_ID,
  parseArguments,
  usage,
  canonicalPath,
  isPathInside,
  parseLinuxMountInfo,
  mountInfoPathInsideLiveDisk,
  isLiveRenderPath,
  deploymentCommit,
  sourceManifest,
  manifestsMatch,
  databaseLogicalDigest,
  previousMonth,
  expectedTrailingMonths,
  commonTrailingMonthWindow,
  latestClosedYearMonth,
  oldestAllowedRegionMonth,
  compareCompanyReference,
  expectedRegionalMetrics,
  compareRegionReference,
  databaseAudit,
  runAudit,
  formatReport,
  cleanupTemporaryAudit,
  main
};
