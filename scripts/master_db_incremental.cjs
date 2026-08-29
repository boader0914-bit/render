const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeStatus,
  statusRank,
  safeJson,
  stableId,
  sha256Buffer,
  sha256File,
  numberOrNull,
  openMasterDatabase,
  applySchema,
  withTransaction
} = require("./master_db.cjs");
const {
  seedReferenceTables,
  registerArtifact,
  importRegions,
  regionLookup,
  resolveRegionId,
  importTourismRegionMap,
  ensureKeyword,
  insertCollectionRun,
  importHistoryObservationRows,
  importTourismCacheFile,
  tourismSourceFromSnapshot,
  manifestListedFileNames,
  manifestCompletedAt,
  redactSensitive
} = require("./master_db_import.cjs");
const {
  VISITOR_ADAPTER_VERSION,
  DEMAND_STRENGTH_ADAPTER_VERSION,
  DEMAND_STRENGTH_OPERATIONS,
  RESOURCE_DEMAND_ADAPTER_VERSION,
  DIVERSITY_ADAPTER_VERSION,
  RESOURCE_DEMAND_OPERATIONS,
  DIVERSITY_OPERATIONS
} = require("./tourism_collector.cjs");
const { validateCompanyObservation } = require("./master_db_quality.cjs");

const DEFAULT_RECONCILE_LIMIT = 200;

function isPathInside(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingInside(basePath, candidatePath) {
  const base = fs.realpathSync(basePath);
  const candidate = fs.realpathSync(candidatePath);
  if (!isPathInside(base, candidate)) {
    const error = new Error(`허용된 자료 폴더 밖의 파일은 반입할 수 없습니다: ${candidatePath}`);
    error.code = "master_db_path_outside_data_root";
    throw error;
  }
  return candidate;
}

function safeJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readHistoryRowsForRun(filePath, runId) {
  if (!fs.existsSync(filePath)) return { rows: [], parseErrors: 0 };
  const rows = [];
  let parseErrors = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (cleanText(row?.runId) === runId) rows.push(row);
    } catch {
      parseErrors += 1;
    }
  }
  return { rows, parseErrors };
}

function readHistoryRowsGrouped(filePath) {
  const grouped = new Map();
  if (!fs.existsSync(filePath)) return grouped;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const runId = cleanText(row?.runId);
      if (!runId) continue;
      if (!grouped.has(runId)) grouped.set(runId, []);
      grouped.get(runId).push(row);
    } catch {
      // Legacy fallback rows are only used for partial audit receipts.
    }
  }
  return grouped;
}

function dedupeHistoryRows(rows = []) {
  const deduped = new Map();
  for (const row of rows) {
    const observationId = cleanText(row?.observationId);
    if (!observationId) continue;
    const serialized = safeJson(row);
    const existing = deduped.get(observationId);
    if (existing && existing.serialized !== serialized) {
      const error = new Error(`같은 관측 ID에 서로 다른 회차 증거가 있습니다: ${observationId}`);
      error.code = "history_observation_conflict";
      throw error;
    }
    deduped.set(observationId, { row, serialized });
  }
  return [...deduped.values()].map((entry) => entry.row);
}

function findRunHistoryEvidence(event, options, runId) {
  const evidenceRoot = path.join(options.dataDir, "history", "evidence");
  const requested = cleanText(event.history?.evidence?.filePath || event.history?.evidence?.file);
  const candidates = [];
  if (requested) {
    candidates.push(path.isAbsolute(requested) ? requested : path.join(options.dataDir, requested));
  }
  if (fs.existsSync(evidenceRoot)) {
    candidates.push(...fs.readdirSync(evidenceRoot)
      .filter((name) => name.startsWith(`${runId}__`) && name.toLowerCase().endsWith(".json"))
      .map((name) => path.join(evidenceRoot, name)));
  }
  const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)).filter((candidate) => fs.existsSync(candidate)))];
  if (!uniqueCandidates.length) return null;
  if (uniqueCandidates.length > 1) {
    const hashes = new Set(uniqueCandidates.map(sha256File));
    if (hashes.size > 1) {
      const error = new Error(`같은 회차에 서로 다른 관측 증거파일이 있습니다: ${runId}`);
      error.code = "history_evidence_conflict";
      throw error;
    }
  }
  const filePath = resolveExistingInside(evidenceRoot, uniqueCandidates[0]);
  const sha256 = sha256File(filePath);
  const expectedSha = cleanText(event.history?.evidence?.sha256);
  if (expectedSha && expectedSha !== sha256) {
    const error = new Error(`수집 완료 시점과 현재 관측 증거 해시가 다릅니다: ${runId}`);
    error.code = "history_evidence_hash_mismatch";
    throw error;
  }
  const payload = safeJsonFile(filePath);
  if (cleanText(payload.runId) !== runId || !Array.isArray(payload.observations)) {
    const error = new Error(`회차 관측 증거 형식이 올바르지 않습니다: ${runId}`);
    error.code = "invalid_history_evidence";
    throw error;
  }
  const rows = dedupeHistoryRows(payload.observations.filter((row) => cleanText(row?.runId) === runId));
  if (Number(payload.observationCount) !== rows.length) {
    const error = new Error(`회차 관측 증거 건수가 일치하지 않습니다: ${runId}`);
    error.code = "history_evidence_count_mismatch";
    throw error;
  }
  return { filePath, sha256, rows, immutable: true };
}

function normalizeRunId(value) {
  const runId = cleanText(value);
  if (!runId || path.basename(runId) !== runId || !/^[\p{L}\p{N}._-]+$/u.test(runId)) {
    const error = new Error("유효하지 않은 수집 회차 ID입니다.");
    error.code = "invalid_master_db_run_id";
    throw error;
  }
  return runId;
}

function artifactHash(database, artifactId) {
  return database.prepare("SELECT sha256 FROM source_artifacts WHERE artifact_id = ?").get(artifactId)?.sha256 || "";
}

function relativeDataArtifactPath(filePath, dataDir) {
  const relative = path.relative(dataDir, filePath);
  return relative.replace(/\\/g, "/");
}

function verifyExistingRunArtifact(database, runId, filePath, expectedSha, dataDir) {
  const relativePath = relativeDataArtifactPath(filePath, dataDir);
  const rows = database.prepare(`
    SELECT sha256
    FROM source_artifacts
    WHERE run_id = ? AND source_id = 'naver_place' AND relative_path = ?
  `).all(runId, relativePath);
  if (rows.some((row) => row.sha256 !== expectedSha)) {
    const error = new Error(`같은 회차의 결과 파일 내용이 변경되었습니다: ${relativePath}`);
    error.code = "run_output_artifact_conflict";
    throw error;
  }
  return rows.some((row) => row.sha256 === expectedSha);
}

function insertReceipt(database, record) {
  let status = normalizeStatus(record.status);
  const hasEvidence = Boolean(cleanText(record.evidenceContentHash));
  if (status === "complete" && !hasEvidence) status = "partial";
  const receiptId = cleanText(record.receiptId) || stableId(
    "rcpt",
    record.runId,
    record.sourceId,
    record.regionId,
    record.companyId,
    record.evidenceContentHash,
    status
  );
  database.prepare(`
    INSERT INTO collection_receipts (
      receipt_id, run_id, source_id, region_id, company_id,
      observed_period_start, observed_period_end, status, status_rank,
      quality_score, reason_code, source_artifact_id, evidence_content_hash,
      raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(receipt_id) DO NOTHING
  `).run(
    receiptId,
    record.runId || null,
    record.sourceId,
    record.regionId || null,
    record.companyId || null,
    record.periodStart || null,
    record.periodEnd || null,
    status,
    statusRank(status),
    record.qualityScore ?? null,
    record.reasonCode || null,
    record.sourceArtifactId || null,
    record.evidenceContentHash || null,
    safeJson(redactSensitive(record.raw || null)),
    record.createdAt || nowIso()
  );
  return { receiptId, status };
}

function bootstrapReferenceData(database, options) {
  const regionMasterFile = path.join(options.rootDir, "web", "data", "region_master.json");
  const tourismRegionMapFile = path.join(options.rootDir, "web", "data", "tourism_region_map.json");
  const referenceFiles = [regionMasterFile, tourismRegionMapFile].filter((filePath) => fs.existsSync(filePath));
  const currentHash = sha256Buffer(Buffer.from(referenceFiles.map((filePath) => `${path.basename(filePath)}:${sha256File(filePath)}`).join("\n")));
  const storedHash = database.prepare("SELECT meta_value FROM master_meta WHERE meta_key = 'incremental_reference_hash'").get()?.meta_value || "";
  if (storedHash === currentHash && Number(database.prepare("SELECT COUNT(*) AS count FROM administrative_regions").get().count) > 1) {
    return regionLookup(database);
  }
  seedReferenceTables(database);
  const regionArtifactId = fs.existsSync(regionMasterFile)
    ? registerArtifact(database, regionMasterFile, options.dataDir, null, "region_catalog")
    : null;
  importRegions(database, fs.existsSync(regionMasterFile) ? regionMasterFile : "", regionArtifactId);
  let lookup = regionLookup(database);
  const mapArtifactId = fs.existsSync(tourismRegionMapFile)
    ? registerArtifact(database, tourismRegionMapFile, options.dataDir, null, "region_catalog")
    : null;
  importTourismRegionMap(database, fs.existsSync(tourismRegionMapFile) ? tourismRegionMapFile : "", mapArtifactId, lookup);
  database.prepare(`
    INSERT INTO master_meta (meta_key, meta_value, updated_at)
    VALUES ('incremental_reference_hash', ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at
  `).run(currentHash, nowIso());
  lookup = regionLookup(database);
  return lookup;
}

function prepareNaverRun(event, options) {
  const runId = normalizeRunId(event.runId);
  const requestedDir = event.runDir ? path.resolve(event.runDir) : path.join(options.outputsDir, runId);
  const runDir = resolveExistingInside(options.outputsDir, requestedDir);
  const manifestPath = resolveExistingInside(runDir, path.join(runDir, "manifest.json"));
  const manifest = safeJsonFile(manifestPath);
  const manifestSha = sha256File(manifestPath);
  const expectedManifestSha = cleanText(event.manifestSha256);
  if (expectedManifestSha && expectedManifestSha !== manifestSha) {
    const error = new Error(`수집 완료 시점과 현재 manifest 해시가 다릅니다: ${runId}`);
    error.code = "run_manifest_changed_before_ingest";
    throw error;
  }
  const listedNames = manifestListedFileNames(manifest);
  const optionalNames = ["traffic_metrics.json"].filter((name) => fs.existsSync(path.join(runDir, name)));
  const listedFiles = [];
  const missingFiles = [];
  const fileHashes = [];
  for (const name of [...listedNames, ...optionalNames]) {
    const candidate = path.resolve(runDir, name);
    if (!isPathInside(runDir, candidate) || !fs.existsSync(candidate)) {
      missingFiles.push(name);
      continue;
    }
    const filePath = resolveExistingInside(runDir, candidate);
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      missingFiles.push(name);
      continue;
    }
    listedFiles.push(filePath);
    fileHashes.push({
      filePath,
      relativePath: path.relative(runDir, filePath).replace(/\\/g, "/"),
      sha256: sha256File(filePath),
      byteSize: stats.size
    });
  }
  const collectionPurpose = cleanText(manifest.collectionPurpose || event.plan?.collectionPurpose || "revenue_detail");
  const collectionProfile = cleanText(manifest.collectionProfile || event.plan?.collectionProfile || "");
  const historyApplicable = !["basic_db", "demand_location"].includes(collectionPurpose) && collectionProfile !== "fast_rank";
  const historyEvidence = historyApplicable ? findRunHistoryEvidence(event, options, runId) : null;
  let history;
  if (historyEvidence) {
    history = { rows: historyEvidence.rows, parseErrors: 0, evidence: historyEvidence };
  } else if (!historyApplicable) {
    history = { rows: [], parseErrors: 0, evidence: null };
  } else {
    const fallbackHistory = Array.isArray(event.historyRows)
      ? { rows: event.historyRows, parseErrors: 0 }
      : readHistoryRowsForRun(path.join(options.dataDir, "history", "observations.jsonl"), runId);
    history = { ...fallbackHistory, rows: dedupeHistoryRows(fallbackHistory.rows), evidence: null };
  }
  const filesComplete = listedNames.length > 0 && missingFiles.length === 0;
  const expectedHistoryCount = Number(event.history?.appended);
  const historyCountMatches = !Number.isFinite(expectedHistoryCount) || expectedHistoryCount === history.rows.length;
  const observationsComplete = history.rows.length > 0 && historyCountMatches && Boolean(history.evidence?.immutable);
  const status = filesComplete ? "complete" : "partial";
  const observationStatus = !filesComplete
    ? "partial"
    : observationsComplete || !historyApplicable
      ? "complete"
      : "partial";
  const reasonCode = !filesComplete
    ? (listedNames.length ? "manifest_file_missing" : "manifest_file_list_missing")
    : !historyApplicable
      ? "history_not_applicable"
      : history.rows.length > 0 && !history.evidence?.immutable
        ? "immutable_history_evidence_missing"
        : !historyCountMatches
          ? "history_observation_count_mismatch"
          : !observationsComplete
            ? "history_observation_missing"
      : "";
  const evidenceContentHash = history.evidence?.sha256 || manifestSha;
  return {
    runId,
    runDir,
    manifestPath,
    manifest,
    manifestSha,
    listedFiles,
    fileHashes,
    missingFiles,
    history,
    historyApplicable,
    status,
    observationStatus,
    reasonCode,
    evidenceContentHash
  };
}

function assertRunManifestUnchanged(database, prepared, manifestArtifactId) {
  const existing = database.prepare(`
    SELECT artifact.sha256, artifact.file_role
    FROM collection_runs run
    LEFT JOIN source_artifacts artifact ON artifact.artifact_id = run.source_artifact_id
    WHERE run.run_id = ?
  `).get(prepared.runId);
  if (existing?.file_role === "collection_manifest" && existing.sha256 && existing.sha256 !== prepared.manifestSha) {
    const error = new Error(`같은 회차 ID의 manifest 내용이 달라 반입을 중단합니다: ${prepared.runId}`);
    error.code = "run_manifest_conflict";
    throw error;
  }
  const registeredHash = artifactHash(database, manifestArtifactId);
  if (registeredHash !== prepared.manifestSha) {
    const error = new Error(`manifest 해시 검증에 실패했습니다: ${prepared.runId}`);
    error.code = "run_manifest_hash_mismatch";
    throw error;
  }
}

function ingestPreparedNaverRun(database, prepared, options, event = {}) {
  return withTransaction(database, () => {
    const existingRun = database.prepare(`
      SELECT artifact.sha256 AS manifest_sha
      FROM collection_runs run
      LEFT JOIN source_artifacts artifact ON artifact.artifact_id = run.source_artifact_id
      WHERE run.run_id = ?
    `).get(prepared.runId);
    if (existingRun?.manifest_sha && existingRun.manifest_sha !== prepared.manifestSha) {
      const error = new Error(`같은 회차 ID의 manifest 내용이 달라 반입을 중단합니다: ${prepared.runId}`);
      error.code = "run_manifest_conflict";
      throw error;
    }
    const existingReceipt = database.prepare(`
      SELECT COUNT(*) AS count, MAX(status_rank) AS max_status_rank
      FROM collection_receipts
      WHERE run_id = ? AND evidence_content_hash = ?
    `).get(prepared.runId, prepared.evidenceContentHash);
    const existingReceiptCount = Number(existingReceipt?.count || 0);
    const existingObservationCount = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM company_observations WHERE run_id = ?"
    ).get(prepared.runId)?.count || 0);
    const outputArtifactsMatch = prepared.fileHashes.every((file) => verifyExistingRunArtifact(
      database,
      prepared.runId,
      file.filePath,
      file.sha256,
      options.dataDir
    ));
    const historyArtifactMatches = !prepared.history.evidence || verifyExistingRunArtifact(
      database,
      prepared.runId,
      prepared.history.evidence.filePath,
      prepared.history.evidence.sha256,
      options.dataDir
    );
    const receiptStatusSufficient = Number(existingReceipt?.max_status_rank || 0) >= statusRank(prepared.observationStatus);
    const observationsSufficient = !prepared.historyApplicable
      || prepared.observationStatus !== "complete"
      || existingObservationCount === prepared.history.rows.length;
    if (existingRun?.manifest_sha === prepared.manifestSha
      && existingReceiptCount > 0
      && outputArtifactsMatch
      && historyArtifactMatches
      && receiptStatusSufficient
      && observationsSufficient) {
      return {
        type: "naver_run",
        runId: prepared.runId,
        status: prepared.status,
        observationStatus: prepared.observationStatus,
        observations: existingObservationCount,
        receipts: existingReceiptCount,
        missingFiles: prepared.missingFiles.length,
        unchanged: true
      };
    }
    const manifestArtifactId = registerArtifact(database, prepared.manifestPath, options.dataDir, prepared.runId, "naver_place");
    assertRunManifestUnchanged(database, prepared, manifestArtifactId);
    for (const file of prepared.fileHashes) {
      const artifactId = registerArtifact(database, file.filePath, options.dataDir, prepared.runId, "naver_place");
      if (artifactHash(database, artifactId) !== file.sha256) {
        const error = new Error(`수집 결과 파일이 검증 중 변경되었습니다: ${file.relativePath}`);
        error.code = "run_file_changed_before_ingest";
        throw error;
      }
    }
    const historyArtifactId = prepared.history.evidence
      ? registerArtifact(database, prepared.history.evidence.filePath, options.dataDir, prepared.runId, "naver_place")
      : null;
    if (historyArtifactId && artifactHash(database, historyArtifactId) !== prepared.history.evidence.sha256) {
      const error = new Error(`관측 증거가 검증 중 변경되었습니다: ${prepared.runId}`);
      error.code = "history_evidence_changed_before_ingest";
      throw error;
    }
    const regionCandidate = cleanText(prepared.manifest.searchKeyword || prepared.manifest.keyword)
      .replace(/(글램핑|캠핑장|카라반|펜션|풀빌라|숙박|숙소)/g, "")
      .trim();
    const lookup = regionLookup(database);
    const regionId = resolveRegionId(regionCandidate, lookup);
    const keywordId = ensureKeyword(database, prepared.manifest.keyword || prepared.manifest.searchKeyword, {
      keywordType: prepared.manifest.keywordType || null,
      regionId,
      raw: prepared.manifest
    });
    const completedAt = manifestCompletedAt(prepared.manifest, prepared.manifestPath, event.endedAt);
    insertCollectionRun(database, {
      runId: prepared.runId,
      sourceId: "naver_place",
      runLabel: prepared.manifest.keyword || prepared.runId,
      keywordId,
      queryText: prepared.manifest.searchKeyword || prepared.manifest.naverKeyword || prepared.manifest.keyword || null,
      searchMode: prepared.manifest.searchMode || null,
      productMode: prepared.manifest.productMode || null,
      periodStart: prepared.manifest.checkIn || null,
      periodEnd: prepared.manifest.checkOut || null,
      startedAt: prepared.manifest.startedAt || event.startedAt || null,
      completedAt,
      status: prepared.status,
      artifactId: manifestArtifactId,
      raw: {
        manifest: prepared.manifest,
        dualWrite: {
          mode: "shadow",
          missingFiles: prepared.missingFiles,
          historyRows: prepared.history.rows.length,
          historyParseErrors: prepared.history.parseErrors,
          event: redactSensitive(event)
        }
      }
    });
    let imported = { count: 0, rows: [] };
    const mayImportObservations = prepared.status === "complete"
      && prepared.observationStatus === "complete"
      && prepared.historyApplicable
      && prepared.history.evidence?.immutable
      && historyArtifactId
      && prepared.history.rows.length > 0;
    if (mayImportObservations) {
      imported = importHistoryObservationRows(database, prepared.history.rows, historyArtifactId, {
        runId: prepared.runId,
        validateObservation: validateCompanyObservation
      });
    }
    const rowsByCompany = new Map();
    for (const row of imported.rows) {
      if (!rowsByCompany.has(row.companyId)) rowsByCompany.set(row.companyId, []);
      rowsByCompany.get(row.companyId).push(row);
    }
    if (rowsByCompany.size) {
      for (const [companyId, rows] of rowsByCompany.entries()) {
        const dates = rows.map((row) => row.stayDate).filter(Boolean).sort();
        const completeRows = rows.filter((row) => row.status === "complete");
        const qualityValues = rows.map((row) => row.qualityScore).filter(Number.isFinite);
        const receiptStatus = completeRows.length === rows.length ? "complete" : "partial";
        const qualityScore = qualityValues.length
          ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length
          : completeRows.length / rows.length;
        const qualityReasons = [...new Set(rows.flatMap((row) => row.qualityReasons || []))];
        insertReceipt(database, {
          runId: prepared.runId,
          sourceId: "naver_place",
          regionId,
          companyId,
          periodStart: dates[0] || prepared.manifest.checkIn || null,
          periodEnd: dates.at(-1) || prepared.manifest.checkOut || null,
          status: receiptStatus,
          qualityScore,
          reasonCode: qualityReasons.length ? "observation_quality_failed" : null,
          sourceArtifactId: historyArtifactId,
          evidenceContentHash: prepared.history.evidence.sha256,
          raw: { rowCount: rows.length, qualityReasons, manifestSha256: prepared.manifestSha }
        });
      }
    } else {
      insertReceipt(database, {
        runId: prepared.runId,
        sourceId: "naver_place",
        regionId,
        periodStart: prepared.manifest.checkIn || null,
        periodEnd: prepared.manifest.checkOut || null,
        status: prepared.observationStatus,
        qualityScore: prepared.observationStatus === "complete" ? 1 : null,
        reasonCode: prepared.reasonCode,
        sourceArtifactId: historyArtifactId || manifestArtifactId,
        evidenceContentHash: prepared.evidenceContentHash,
        raw: {
          rowCount: 0,
          historyApplicable: prepared.historyApplicable,
          missingFiles: prepared.missingFiles,
          manifestSha256: prepared.manifestSha
        }
      });
    }
    return {
      type: "naver_run",
      runId: prepared.runId,
      status: prepared.status,
      observationStatus: prepared.observationStatus,
      observations: imported.count,
      receipts: Math.max(1, rowsByCompany.size),
      missingFiles: prepared.missingFiles.length
    };
  });
}

const TOURISM_SOURCE_KEYS = Object.freeze({
  kto_visitor_api: "visitors",
  kto_demand_strength_api: "demandStrength",
  kto_resource_demand_api: "resourceDemand",
  kto_tourism_diversity_api: "diversity"
});

const TOURISM_ADAPTERS = Object.freeze({
  kto_visitor_api: VISITOR_ADAPTER_VERSION,
  kto_demand_strength_api: DEMAND_STRENGTH_ADAPTER_VERSION,
  kto_resource_demand_api: RESOURCE_DEMAND_ADAPTER_VERSION,
  kto_tourism_diversity_api: DIVERSITY_ADAPTER_VERSION
});

function tourismOperationDefinitions(sourceId) {
  if (sourceId === "kto_demand_strength_api") return DEMAND_STRENGTH_OPERATIONS;
  if (sourceId === "kto_resource_demand_api") return RESOURCE_DEMAND_OPERATIONS;
  if (sourceId === "kto_tourism_diversity_api") return DIVERSITY_OPERATIONS;
  return null;
}

function validateVisitorRegionRow(row = {}, expectedYearMonth = "") {
  const reasons = [];
  if (!cleanText(row.regionKey)) reasons.push("missing_region_key");
  if (row.yearMonth && cleanText(row.yearMonth) !== expectedYearMonth) reasons.push("region_period_mismatch");
  const visitorDays = numberOrNull(row.visitorDays);
  const averageDailyVisitors = numberOrNull(row.averageDailyVisitors);
  const coverageRate = numberOrNull(row.coverageRate);
  const observedDays = numberOrNull(row.observedDays);
  const expectedDays = numberOrNull(row.expectedDays);
  if (normalizeStatus(row.quality?.status) !== "complete") reasons.push(cleanText(row.quality?.reason) || "region_quality_not_complete");
  if (visitorDays === null || visitorDays < 0) reasons.push("invalid_visitor_days");
  if (averageDailyVisitors === null || averageDailyVisitors < 0) reasons.push("invalid_average_daily_visitors");
  if (coverageRate === null || coverageRate < 0 || coverageRate > 1) reasons.push("invalid_coverage_rate");
  if (!Number.isInteger(observedDays) || observedDays <= 0 || observedDays > 31) reasons.push("invalid_observed_days");
  if (!Number.isInteger(expectedDays) || expectedDays <= 0 || expectedDays > 31) reasons.push("invalid_expected_days");
  if (Number.isInteger(observedDays) && Number.isInteger(expectedDays) && observedDays !== expectedDays) reasons.push("incomplete_date_coverage");
  if (Number.isInteger(observedDays) && Number.isInteger(expectedDays) && expectedDays > 0 && coverageRate !== null
    && Math.abs((observedDays / expectedDays) - coverageRate) > 0.0001) reasons.push("coverage_rate_mismatch");
  const categoryValues = [];
  for (const code of ["1", "2", "3"]) {
    const value = numberOrNull(row.categoryVisitorDays?.[code]);
    if (value === null || value < 0) reasons.push(`invalid_visitor_category_${code}`);
    else categoryValues.push(value);
  }
  if (visitorDays !== null && categoryValues.length === 3
    && Math.abs(categoryValues.reduce((sum, value) => sum + value, 0) - visitorDays) > 1) reasons.push("visitor_category_total_mismatch");
  if (visitorDays !== null && Number.isInteger(observedDays) && observedDays > 0 && averageDailyVisitors !== null
    && Math.abs(Math.round(visitorDays / observedDays) - averageDailyVisitors) > 1) reasons.push("visitor_average_mismatch");
  return {
    regionKey: cleanText(row.regionKey),
    status: reasons.length ? "partial" : "complete",
    promoteCurrent: reasons.length === 0,
    qualityScore: reasons.length ? 0 : 1,
    reasons
  };
}

function validateTourismOperations(snapshot, sourceId) {
  const definitions = tourismOperationDefinitions(sourceId) || {};
  const contractReasons = [];
  const detailReasons = [];
  let completeOperations = 0;
  let detailCompleteOperations = 0;
  for (const [key, definition] of Object.entries(definitions)) {
    const operation = snapshot.operations?.[key];
    if (!operation || typeof operation !== "object") {
      contractReasons.push(`missing_operation_${key}`);
      continue;
    }
    if (cleanText(operation.operation) !== cleanText(definition.operation)) {
      contractReasons.push(`operation_contract_mismatch_${key}`);
    }
    if (normalizeStatus(operation.status) !== "complete") contractReasons.push(`operation_not_complete_${key}`);
    const valuesByCode = new Map();
    let duplicateCode = false;
    for (const metric of Array.isArray(operation.metrics) ? operation.metrics : []) {
      const code = cleanText(metric?.code);
      if (!code) continue;
      if (valuesByCode.has(code)) duplicateCode = true;
      valuesByCode.set(code, numberOrNull(metric?.value));
    }
    if (duplicateCode) contractReasons.push(`duplicate_metric_code_${key}`);
    const overallValue = numberOrNull(operation.overallValue);
    const overallMetric = valuesByCode.get(cleanText(definition.overallCode));
    const overallComplete = overallValue !== null && overallMetric !== null && overallValue === overallMetric;
    if (!overallComplete) contractReasons.push(`overall_metric_invalid_${key}`);
    else completeOperations += 1;
    const expectedCodes = Object.keys(definition.expectedMetrics || {});
    const detailComplete = expectedCodes.length > 0
      && expectedCodes.every((code) => valuesByCode.get(code) !== null && valuesByCode.get(code) !== undefined)
      && operation.quality?.detailComplete === true;
    if (detailComplete) detailCompleteOperations += 1;
    else detailReasons.push(`detail_metrics_incomplete_${key}`);
  }
  const requiredOperations = Object.keys(definitions).length;
  const overallComplete = requiredOperations > 0 && completeOperations === requiredOperations;
  const detailComplete = overallComplete && detailCompleteOperations === requiredOperations;
  const allowDetailPartial = sourceId === "kto_demand_strength_api";
  const accepted = contractReasons.length === 0
    && overallComplete
    && (allowDetailPartial || detailComplete);
  const qualityScore = requiredOperations
    ? (allowDetailPartial ? detailCompleteOperations / requiredOperations : completeOperations / requiredOperations)
    : 0;
  return {
    accepted,
    status: accepted && detailComplete ? "complete" : accepted ? "partial" : "rejected",
    qualityScore,
    reasons: [...new Set([...contractReasons, ...detailReasons])]
  };
}

function validateTourismSnapshot(snapshot, sourceId, event = {}, expectedVisitorRegionKeys = []) {
  const reasons = [];
  const expectedAdapter = TOURISM_ADAPTERS[sourceId];
  const expectedSourceKey = TOURISM_SOURCE_KEYS[sourceId];
  const yearMonth = cleanText(snapshot.yearMonth);
  if (cleanText(snapshot.adapter) !== expectedAdapter) reasons.push("adapter_contract_mismatch");
  if (event.adapter && cleanText(event.adapter) !== cleanText(snapshot.adapter)) reasons.push("event_adapter_mismatch");
  if (event.sourceKey && cleanText(event.sourceKey) !== expectedSourceKey) reasons.push("source_key_mismatch");
  if (!/^\d{6}$/.test(yearMonth) || Number(yearMonth.slice(4, 6)) < 1 || Number(yearMonth.slice(4, 6)) > 12) reasons.push("invalid_year_month");
  if (event.yearMonth && cleanText(event.yearMonth) !== yearMonth) reasons.push("event_period_mismatch");
  const regionKey = cleanText(snapshot.region?.regionKey);
  if (event.regionKey && cleanText(event.regionKey) !== "all" && cleanText(event.regionKey) !== regionKey) reasons.push("event_region_mismatch");
  if (normalizeStatus(snapshot.status) !== "complete") reasons.push("snapshot_not_complete");

  if (sourceId === "kto_visitor_api") {
    if (!Array.isArray(snapshot.allRegions) || snapshot.allRegions.length === 0) reasons.push("visitor_regions_missing");
    const regions = Array.isArray(snapshot.allRegions)
      ? snapshot.allRegions.map((row) => validateVisitorRegionRow(row, yearMonth))
      : [];
    const actualRegionKeys = regions.map((region) => region.regionKey).filter(Boolean);
    const duplicateRegionKeys = actualRegionKeys.filter((regionKey, index) => actualRegionKeys.indexOf(regionKey) !== index);
    const expectedSet = new Set(expectedVisitorRegionKeys);
    const actualSet = new Set(actualRegionKeys);
    const missingRegionKeys = [...expectedSet].filter((regionKey) => !actualSet.has(regionKey));
    const unexpectedRegionKeys = [...actualSet].filter((regionKey) => expectedSet.size && !expectedSet.has(regionKey));
    if (!expectedSet.size) reasons.push("visitor_region_contract_missing");
    if (duplicateRegionKeys.length) reasons.push("visitor_region_duplicate");
    if (missingRegionKeys.length) reasons.push("visitor_regions_truncated");
    if (unexpectedRegionKeys.length) reasons.push("visitor_region_unexpected");
    const completeRegions = regions.filter((region) => region.status === "complete").length;
    if (!completeRegions) reasons.push("visitor_complete_region_missing");
    const accepted = reasons.length === 0;
    return {
      accepted,
      status: accepted && completeRegions === regions.length ? "complete" : accepted ? "partial" : "rejected",
      qualityScore: regions.length ? completeRegions / regions.length : 0,
      reasons: [...new Set(reasons)],
      regions,
      missingRegionKeys,
      unexpectedRegionKeys
    };
  }

  const operationValidation = validateTourismOperations(snapshot, sourceId);
  return {
    ...operationValidation,
    accepted: reasons.length === 0 && operationValidation.accepted,
    status: reasons.length ? "rejected" : operationValidation.status,
    reasons: [...new Set([...reasons, ...operationValidation.reasons])],
    regions: []
  };
}

function resolveTourismSnapshotPath(event, options) {
  const requested = cleanText(event.evidencePath);
  if (!requested) {
    const error = new Error("증분 반입에는 불변 관광 Evidence 경로가 필요합니다.");
    error.code = "immutable_tourism_evidence_required";
    throw error;
  }
  const candidate = path.resolve(path.isAbsolute(requested) ? requested : path.join(options.dataDir, requested));
  const roots = [path.join(options.dataDir, "tourism_data", "evidence", "cache_snapshots")]
    .filter((root) => fs.existsSync(root));
  for (const root of roots) {
    try {
      return resolveExistingInside(root, candidate);
    } catch (error) {
      if (error.code !== "master_db_path_outside_data_root") throw error;
    }
  }
  const error = new Error("허용된 관광 Evidence 폴더 밖의 파일은 반입할 수 없습니다.");
  error.code = "tourism_snapshot_outside_allowed_root";
  throw error;
}

function prepareTourismSnapshot(event, options) {
  const filePath = resolveTourismSnapshotPath(event, options);
  if (path.extname(filePath).toLowerCase() !== ".json") {
    const error = new Error("관광 캐시는 JSON 파일만 반입할 수 있습니다.");
    error.code = "invalid_tourism_cache_type";
    throw error;
  }
  const snapshot = safeJsonFile(filePath);
  const sourceId = tourismSourceFromSnapshot(snapshot, filePath);
  if (!sourceId) {
    const error = new Error("지원하지 않는 관광 캐시 형식입니다.");
    error.code = "unknown_tourism_source";
    throw error;
  }
  const sha256 = sha256File(filePath);
  const expectedSha = cleanText(event.sha256);
  if (!/^[a-f0-9]{64}$/i.test(expectedSha) || path.basename(filePath, ".json") !== expectedSha) {
    const error = new Error("관광 Evidence 파일명과 이벤트 SHA가 일치하지 않습니다.");
    error.code = "invalid_tourism_evidence_identity";
    throw error;
  }
  if (expectedSha !== sha256) {
    const error = new Error("관광 Snapshot이 저장 완료 시점 이후 변경되었습니다.");
    error.code = "tourism_snapshot_hash_mismatch";
    throw error;
  }
  const tourismRegionMapFile = path.join(options.rootDir, "web", "data", "tourism_region_map.json");
  const expectedVisitorRegionKeys = sourceId === "kto_visitor_api" && fs.existsSync(tourismRegionMapFile)
    ? (safeJsonFile(tourismRegionMapFile).regions || []).map((row) => cleanText(row.regionKey)).filter(Boolean)
    : [];
  const validation = validateTourismSnapshot(snapshot, sourceId, event, expectedVisitorRegionKeys);
  if (!validation.accepted) {
    const error = new Error(`관광 Snapshot 계약 검증에 실패했습니다: ${validation.reasons.join(",")}`);
    error.code = "tourism_snapshot_contract_failed";
    error.reasons = validation.reasons;
    throw error;
  }
  return { filePath, snapshot, sourceId, sha256, validation };
}

function ingestPreparedTourismSnapshot(database, prepared, options) {
  return withTransaction(database, () => {
    const lookup = regionLookup(database);
    const existingReceipts = database.prepare(`
      SELECT run_id, COUNT(*) AS count
      FROM collection_receipts
      WHERE source_id = ? AND evidence_content_hash = ?
      GROUP BY run_id
      ORDER BY created_at DESC
      LIMIT 1
    `).get(prepared.sourceId, prepared.sha256);
    if (existingReceipts?.run_id) {
      return {
        type: "tourism_snapshot",
        runId: existingReceipts.run_id,
        sourceId: prepared.sourceId,
        regionId: null,
        status: prepared.validation.status,
        metrics: Number(database.prepare("SELECT COUNT(*) AS count FROM region_metric_observations WHERE run_id = ?").get(existingReceipts.run_id)?.count || 0),
        receipts: Number(existingReceipts.count || 0),
        qualityScore: prepared.validation.qualityScore,
        unchanged: true
      };
    }
    const decisions = new Map((prepared.validation.regions || []).map((row) => [row.regionKey, row]));
    const imported = importTourismCacheFile(database, prepared.filePath, options.dataDir, lookup, {
      validateRegionRow: (row) => decisions.get(cleanText(row.regionKey)) || { promoteCurrent: false }
    });
    if (!imported.runId || !imported.artifactId || imported.metrics <= 0) {
      const error = new Error(`관광 캐시에 저장 가능한 지표가 없습니다: ${path.basename(prepared.filePath)}`);
      error.code = imported.reason || "tourism_cache_without_metrics";
      throw error;
    }
    const storedHash = artifactHash(database, imported.artifactId);
    if (storedHash !== prepared.sha256) {
      const error = new Error("관광 캐시 해시 검증에 실패했습니다.");
      error.code = "tourism_cache_hash_mismatch";
      throw error;
    }
    let receiptCount = 0;
    if (imported.sourceId === "kto_visitor_api") {
      for (const decision of prepared.validation.regions) {
        const regionId = resolveRegionId(decision.regionKey, lookup);
        if (!regionId) continue;
        insertReceipt(database, {
          runId: imported.runId,
          sourceId: imported.sourceId,
          regionId,
          periodStart: imported.range?.start,
          periodEnd: imported.range?.end,
          status: decision.status,
          qualityScore: decision.qualityScore,
          reasonCode: decision.reasons.length ? "visitor_region_quality_failed" : null,
          sourceArtifactId: imported.artifactId,
          evidenceContentHash: prepared.sha256,
          raw: {
            yearMonth: prepared.snapshot.yearMonth,
            regionKey: decision.regionKey,
            qualityReasons: decision.reasons,
            adapter: prepared.snapshot.adapter,
            evidenceFile: path.basename(prepared.filePath)
          }
        });
        receiptCount += 1;
      }
    } else {
      insertReceipt(database, {
        runId: imported.runId,
        sourceId: imported.sourceId,
        regionId: imported.regionId,
        periodStart: imported.range?.start,
        periodEnd: imported.range?.end,
        status: prepared.validation.status,
        qualityScore: prepared.validation.qualityScore,
        reasonCode: prepared.validation.reasons.length ? "tourism_detail_quality_partial" : null,
        sourceArtifactId: imported.artifactId,
        evidenceContentHash: prepared.sha256,
        raw: {
          yearMonth: prepared.snapshot.yearMonth,
          qualityReasons: prepared.validation.reasons,
          metrics: imported.metrics,
          adapter: prepared.snapshot.adapter,
          evidenceFile: path.basename(prepared.filePath)
        }
      });
      receiptCount = 1;
    }
    return {
      type: "tourism_snapshot",
      runId: imported.runId,
      sourceId: imported.sourceId,
      regionId: imported.regionId,
      status: prepared.validation.status,
      metrics: imported.metrics,
      receipts: receiptCount,
      qualityScore: prepared.validation.qualityScore
    };
  });
}

function recentFiles(directoryPath, matcher, limit, options = {}) {
  if (!fs.existsSync(directoryPath)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && matcher(filePath)) files.push(filePath);
    }
  };
  visit(directoryPath);
  const excludedKeys = options.excludedKeys instanceof Set ? options.excludedKeys : new Set();
  const keyForFile = typeof options.keyForFile === "function" ? options.keyForFile : (filePath) => filePath;
  return files
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter((entry) => !excludedKeys.has(keyForFile(entry.filePath)))
    .sort((left, right) => options.oldestFirst
      ? left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath)
      : right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath))
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

function createMasterDbIncrementalProcessor(input = {}) {
  const options = {
    rootDir: path.resolve(input.rootDir || ROOT),
    dataDir: path.resolve(input.dataDir || process.env.DATA_DIR || ROOT),
    outputsDir: path.resolve(input.outputsDir || process.env.OUTPUTS_DIR || path.join(input.dataDir || process.env.DATA_DIR || ROOT, "outputs")),
    databasePath: path.resolve(input.databasePath || process.env.MASTER_DB_PATH || path.join(input.dataDir || process.env.DATA_DIR || ROOT, "master_db", "sabun_master.sqlite"))
  };

  function withDatabase(operation) {
    const database = openMasterDatabase(options.databasePath);
    try {
      applySchema(database);
      withTransaction(database, () => bootstrapReferenceData(database, options));
      return operation(database);
    } finally {
      database.close();
    }
  }

  function ingestNaverRun(event) {
    const prepared = prepareNaverRun(event, options);
    return withDatabase((database) => ingestPreparedNaverRun(database, prepared, options, event));
  }

  function ingestTourismSnapshot(event) {
    const prepared = prepareTourismSnapshot(event, options);
    return withDatabase((database) => ingestPreparedTourismSnapshot(database, prepared, options));
  }

  function reconcile(event = {}) {
    const limit = Math.max(1, Math.min(200, Number(event.limit) || DEFAULT_RECONCILE_LIMIT));
    const sessionExcludedNaverRunIds = new Set((Array.isArray(event.excludeNaverRunIds) ? event.excludeNaverRunIds : [])
      .map(cleanText)
      .filter(Boolean));
    const sessionExcludedTourismEvidenceHashes = new Set((Array.isArray(event.excludeTourismEvidenceHashes) ? event.excludeTourismEvidenceHashes : [])
      .map(cleanText)
      .filter((value) => /^[a-f0-9]{64}$/i.test(value)));
    const processed = withDatabase((database) => ({
      naverRunIds: new Set(database.prepare(`
        SELECT DISTINCT run_id
        FROM collection_receipts
        WHERE source_id = 'naver_place'
          AND run_id IS NOT NULL
          AND (status = 'complete' OR reason_code = 'observation_quality_failed')
      `).all().map((row) => cleanText(row.run_id)).filter(Boolean)),
      tourismEvidenceHashes: new Set(database.prepare(`
        SELECT DISTINCT evidence_content_hash
        FROM collection_receipts
        WHERE source_id IN (
          'kto_visitor_api',
          'kto_demand_strength_api',
          'kto_resource_demand_api',
          'kto_tourism_diversity_api'
        ) AND evidence_content_hash IS NOT NULL
      `).all().map((row) => cleanText(row.evidence_content_hash)).filter(Boolean))
    }));
    const pendingManifestFiles = recentFiles(
      options.outputsDir,
      (filePath) => path.basename(filePath).toLowerCase() === "manifest.json",
      Number.MAX_SAFE_INTEGER,
      {
        excludedKeys: new Set([...processed.naverRunIds, ...sessionExcludedNaverRunIds]),
        keyForFile: (filePath) => path.basename(path.dirname(filePath)),
        oldestFirst: true
      }
    );
    const manifestFiles = pendingManifestFiles.slice(0, limit);
    const historyByRun = readHistoryRowsGrouped(path.join(options.dataDir, "history", "observations.jsonl"));
    const pendingEvidenceFiles = recentFiles(
      path.join(options.dataDir, "tourism_data", "evidence", "cache_snapshots"),
      (filePath) => /^[a-f0-9]{64}\.json$/i.test(path.basename(filePath)),
      Number.MAX_SAFE_INTEGER,
      {
        excludedKeys: new Set([...processed.tourismEvidenceHashes, ...sessionExcludedTourismEvidenceHashes]),
        keyForFile: (filePath) => path.basename(filePath, ".json"),
        oldestFirst: true
      }
    );
    const evidenceFiles = pendingEvidenceFiles.slice(0, limit);
    const results = [];
    const failedNaverRunIds = new Set();
    const failedTourismEvidenceHashes = new Set();
    for (const manifestPath of manifestFiles) {
      const runId = path.basename(path.dirname(manifestPath));
      try {
        results.push(ingestNaverRun({
          type: "naver_run",
          runId,
          runDir: path.dirname(manifestPath),
          historyRows: historyByRun.get(runId) || [],
          reconcile: true
        }));
      } catch (error) {
        failedNaverRunIds.add(runId);
        results.push({ type: "naver_run", runId, status: "skipped", code: error.code || "reconcile_failed" });
      }
    }
    for (const filePath of evidenceFiles) {
      try {
        results.push(ingestTourismSnapshot({
          type: "tourism_snapshot",
          evidencePath: filePath,
          sourceKey: path.basename(path.dirname(filePath)),
          sha256: path.basename(filePath, ".json"),
          reconcile: true
        }));
      } catch (error) {
        failedTourismEvidenceHashes.add(path.basename(filePath, ".json"));
        results.push({ type: "tourism_snapshot", filePath: path.basename(filePath), status: "skipped", code: error.code || "reconcile_failed" });
      }
    }
    const skipped = results.filter((result) => result.status === "skipped").length;
    const remaining = Math.max(0, pendingManifestFiles.length - manifestFiles.length)
      + Math.max(0, pendingEvidenceFiles.length - evidenceFiles.length);
    return {
      type: "reconcile",
      status: skipped ? "partial" : "complete",
      inspected: manifestFiles.length + evidenceFiles.length,
      imported: results.filter((result) => !["skipped", "error"].includes(result.status)).length,
      skipped,
      remaining,
      hasMore: remaining > 0,
      continuation: {
        excludeNaverRunIds: [...new Set([...sessionExcludedNaverRunIds, ...failedNaverRunIds])],
        excludeTourismEvidenceHashes: [...new Set([...sessionExcludedTourismEvidenceHashes, ...failedTourismEvidenceHashes])]
      },
      results
    };
  }

  function processEvent(event = {}) {
    if (event.type === "naver_run") return ingestNaverRun(event);
    if (event.type === "tourism_snapshot") return ingestTourismSnapshot(event);
    if (event.type === "reconcile") return reconcile(event);
    const error = new Error(`지원하지 않는 Master DB 증분 이벤트입니다: ${cleanText(event.type) || "unknown"}`);
    error.code = "unsupported_master_db_event";
    throw error;
  }

  return { options, processEvent, ingestNaverRun, ingestTourismSnapshot, reconcile };
}

module.exports = {
  DEFAULT_RECONCILE_LIMIT,
  isPathInside,
  resolveExistingInside,
  readHistoryRowsForRun,
  insertReceipt,
  createMasterDbIncrementalProcessor
};
