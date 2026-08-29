const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, openMasterDatabase, applySchema, sha256File } = require("./master_db.cjs");
const { applyImport, manifestCompletedAt } = require("./master_db_import.cjs");
const { createMasterDbIncrementalProcessor } = require("./master_db_incremental.cjs");
const {
  mountInfoHasPath,
  renderShadowStorageValidation,
  createMasterDbDualWriteQueue
} = require("./master_db_dual_write.cjs");
const {
  VISITOR_ADAPTER_VERSION,
  DEMAND_STRENGTH_ADAPTER_VERSION,
  DEMAND_STRENGTH_OPERATIONS,
  RESOURCE_DEMAND_ADAPTER_VERSION,
  DIVERSITY_ADAPTER_VERSION,
  RESOURCE_DEMAND_OPERATIONS,
  DIVERSITY_OPERATIONS
} = require("./tourism_collector.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function historyEvidence(dataDir, runId, observations) {
  const payload = {
    schemaVersion: 1,
    evidenceType: "naver_company_observations",
    runId,
    observationCount: observations.length,
    observations
  };
  const serialized = JSON.stringify(payload, null, 2);
  const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
  const filePath = path.join(dataDir, "history", "evidence", `${runId}__${sha256.slice(0, 16)}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized, "utf8");
  return { filePath, sha256, observationCount: observations.length };
}

function fixtureRun(dataDir, outputsDir, runId = "fixture_run_20260830", options = {}) {
  const runDir = path.join(outputsDir, runId);
  const resultName = "fixture.csv";
  const resultText = "name,supply\n테스트글램핑,10\n";
  fs.mkdirSync(runDir, { recursive: true });
  if (!options.missingResult) fs.writeFileSync(path.join(runDir, resultName), resultText, "utf8");
  const detailJsonFiles = [];
  if (options.detailJsonObject) {
    const detailName = "details/fixture-products.json";
    writeJson(path.join(runDir, detailName), [{ name: "테스트 객실", price: 149000 }]);
    detailJsonFiles.push({ field: "products", name: "테스트글램핑", placeId: "1234567890", file: detailName });
  }
  const manifest = {
    keyword: "산청글램핑",
    keywordType: "sigungu",
    searchKeyword: "산청 글램핑",
    naverKeyword: "산청군 글램핑",
    searchMode: "keyword",
    productMode: "lodging",
    collectionPurpose: options.collectionPurpose || "revenue_detail",
    collectionProfile: options.collectionProfile || "revenue_detail_deep",
    checkIn: "2026-09-01",
    checkOut: "2026-09-02",
    startedAt: options.startedAt || "2026-08-30T00:59:00.000Z",
    collectedAt: options.collectedAt || "2026-08-30T01:00:00.000Z",
    files: [resultName],
    detailJsonFiles
  };
  const manifestPath = path.join(runDir, "manifest.json");
  writeJson(manifestPath, manifest);

  const observations = [];
  if (!options.noHistory) {
    observations.push({
      observationId: `obs_${runId}`,
      runId,
      companyKey: Object.hasOwn(options, "companyKey") ? options.companyKey : "cmp_place_1234567890",
      companyName: options.companyName || "테스트글램핑",
      keyword: "산청글램핑",
      keywordKey: "산청글램핑",
      collectedAt: options.collectedAt || "2026-08-30T01:00:00.000Z",
      stayDate: options.stayDate || "2026-09-01",
      leadTimeDays: 2,
      rank: 3,
      region: options.region || "산청",
      productType: "lodging",
      supply: 10,
      available: 4,
      sold: 6,
      saleRate: 0.6,
      price: "149,000원",
      inventoryConfidenceGrade: "B",
      inventoryConfidenceScore: 84,
      sourceUrl: Object.hasOwn(options, "sourceUrl") ? options.sourceUrl : "https://m.place.naver.com/accommodation/1234567890",
      ...(options.observation || {})
    });
    fs.mkdirSync(path.join(dataDir, "history"), { recursive: true });
    fs.appendFileSync(path.join(dataDir, "history", "observations.jsonl"), `${JSON.stringify(observations[0])}\n`, "utf8");
  }
  const evidence = observations.length && !options.noEvidence ? historyEvidence(dataDir, runId, observations) : null;
  const event = {
    type: "naver_run",
    runId,
    runDir,
    manifestSha256: sha256File(manifestPath),
    startedAt: manifest.startedAt,
    endedAt: manifest.collectedAt,
    history: { appended: observations.length, evidence }
  };
  return { runId, runDir, manifestPath, manifest, resultName, resultText, observations, evidence, event };
}

function immutableTourismEvidence(dataDir, sourceKey, snapshot) {
  const serialized = JSON.stringify(snapshot, null, 2);
  const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
  const evidencePath = path.join(dataDir, "tourism_data", "evidence", "cache_snapshots", sourceKey, `${sha256}.json`);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, serialized, "utf8");
  return {
    type: "tourism_snapshot",
    sourceKey,
    evidencePath,
    sha256,
    adapter: snapshot.adapter,
    yearMonth: snapshot.yearMonth,
    regionKey: snapshot.region?.regionKey || "all"
  };
}

function operationFixture(definition, options = {}) {
  const expectedCodes = Object.keys(definition.expectedMetrics || {});
  const omittedCode = options.omitDetail ? expectedCodes.find((code) => code !== definition.overallCode) : "";
  const metrics = expectedCodes.filter((code) => code !== omittedCode).map((code, index) => ({
    code,
    label: definition.expectedMetrics[code],
    value: code === definition.overallCode ? 100 : index + 1
  }));
  return {
    key: definition.key,
    operation: options.operation || definition.operation,
    label: definition.label,
    status: options.status || "ok",
    reason: "",
    overallCode: definition.overallCode,
    overallValue: 100,
    metrics,
    quality: { status: options.omitDetail ? "detail_partial" : "complete", overallComplete: true, detailComplete: !options.omitDetail }
  };
}

function regionalSnapshot(adapter, definitions, options = {}) {
  return {
    schemaVersion: 1,
    adapter,
    status: "ok",
    collectedAt: "2026-08-01T00:00:00.000Z",
    yearMonth: options.yearMonth || "202607",
    region: { regionKey: options.regionKey || "kr_gyeongnam_sancheong", sido: "경남", sigungu: "산청군" },
    operations: Object.fromEntries(Object.entries(definitions).map(([key, definition], index) => [key, operationFixture(definition, {
      omitDetail: Boolean(options.omitDetail && index === 0),
      operation: options.badOperation && index === 0 ? "wrongOperation" : undefined,
      status: options.badStatus && index === 0 ? "error" : undefined
    })])),
    quality: { status: "complete", requiredOperationCount: Object.keys(definitions).length }
  };
}

async function run() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sabun-master-incremental-"));
  const dataDir = path.join(temporaryDirectory, "data");
  const outputsDir = path.join(dataDir, "outputs");
  const databasePath = path.join(dataDir, "master_db", "sabun_master.sqlite");
  fs.mkdirSync(outputsDir, { recursive: true });

  try {
    assert.equal(
      manifestCompletedAt(
        { startedAt: "2026-08-30T00:59:00.000Z" },
        "",
        "2026-08-30T01:00:00.000Z"
      ),
      "2026-08-30T01:00:00.000Z",
      "manifest에 완료시각이 없으면 실제 이벤트 종료시각을 시작시각보다 우선해야 합니다."
    );

    const offDatabasePath = path.join(dataDir, "master_db", "off.sqlite");
    const offQueue = createMasterDbDualWriteQueue({
      rootDir: ROOT,
      dataDir,
      outputsDir,
      databasePath: offDatabasePath,
      mode: "off",
      isRenderRuntime: true,
      renderDiskDir: path.join(temporaryDirectory, "missing-render-disk")
    });
    assert.equal(offQueue.enqueue({ type: "reconcile" }).status, "off");
    assert.equal(fs.existsSync(offDatabasePath), false, "off 모드는 DB 파일을 만들면 안 됩니다.");
    assert.equal(offQueue.status().configurationError, null, "off 모드는 Render disk 검사나 오류 상태를 만들면 안 됩니다.");

    const serverSource = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
    assert.match(
      serverSource,
      /if \(masterDbDualWriteQueue\.mode === "shadow"\) \{\s+const runManifestPath[\s\S]*?result\.masterDbSync = masterDbDualWriteQueue\.enqueue/,
      "manifest hash와 응답 필드는 shadow 모드 안에서만 만들어야 합니다."
    );
    assert.match(
      serverSource,
      /const result = \{ appended: observations\.length, file: "history\/observations\.jsonl" \};\s+if \(masterDbDualWriteQueue\.mode === "shadow"\) result\.evidence = evidence;/,
      "off 모드 history 응답에는 evidence 필드를 추가하면 안 됩니다."
    );

    const missingDiskQueue = createMasterDbDualWriteQueue({
      rootDir: ROOT,
      dataDir,
      outputsDir,
      databasePath,
      mode: "shadow",
      isRenderRuntime: true,
      platform: "linux",
      renderDiskDir: path.join(temporaryDirectory, "missing-render-disk"),
      mountInfoText: "",
      logger: { error() {}, warn() {} }
    });
    const missingDiskResult = missingDiskQueue.enqueue({ type: "reconcile" });
    assert.equal(missingDiskResult.status, "error");
    assert.equal(missingDiskResult.code, "render_persistent_disk_unavailable");
    assert.equal(fs.existsSync(databasePath), false, "영구디스크 검증 실패 시 worker가 DB를 만들면 안 됩니다.");

    const fakeRenderDisk = path.join(temporaryDirectory, "render disk");
    const fakeRenderData = path.join(fakeRenderDisk, "app-data");
    const fakeRenderDatabase = path.join(fakeRenderData, "master_db", "sabun_master.sqlite");
    fs.mkdirSync(fakeRenderData, { recursive: true });
    const escapedMountPath = fakeRenderDisk.replace(/\\/g, "/").replace(/ /g, "\\040");
    const fakeMountInfo = `36 25 0:42 / ${escapedMountPath} rw,relatime - ext4 /dev/test rw`;
    assert.equal(mountInfoHasPath(fakeMountInfo, fakeRenderDisk), true);
    assert.equal(renderShadowStorageValidation({
      isRenderRuntime: true,
      platform: "linux",
      renderDiskDir: fakeRenderDisk,
      dataDir: fakeRenderData,
      databasePath: fakeRenderDatabase,
      mountInfoText: fakeMountInfo
    }).ok, true, "mount된 동일 disk 하위 경로는 허용해야 합니다.");
    const outsideDatabaseValidation = renderShadowStorageValidation({
      isRenderRuntime: true,
      platform: "linux",
      renderDiskDir: fakeRenderDisk,
      dataDir: fakeRenderData,
      databasePath: path.join(temporaryDirectory, "outside", "sabun_master.sqlite"),
      mountInfoText: fakeMountInfo
    });
    assert.equal(outsideDatabaseValidation.ok, false);
    assert.equal(outsideDatabaseValidation.code, "master_db_path_outside_data_root");

    const processor = createMasterDbIncrementalProcessor({ rootDir: ROOT, dataDir, outputsDir, databasePath });
    const complete = fixtureRun(dataDir, outputsDir, "fixture_complete_20260830", { detailJsonObject: true });
    const first = processor.ingestNaverRun(complete.event);
    assert.equal(first.status, "complete");
    assert.equal(first.observationStatus, "complete");
    assert.equal(first.observations, 1);

    let database = openMasterDatabase(databasePath);
    applySchema(database);
    const countsAfterFirst = {
      runs: count(database, "collection_runs"),
      artifacts: count(database, "source_artifacts"),
      observations: count(database, "company_observations"),
      current: count(database, "company_observation_current"),
      receipts: count(database, "collection_receipts")
    };
    assert.equal(countsAfterFirst.observations, 1);
    assert.equal(countsAfterFirst.current, 1);
    assert.equal(count(database, "company_external_ids"), 1);
    const firstReceipt = database.prepare("SELECT status, evidence_content_hash, source_artifact_id FROM collection_receipts WHERE run_id = ?").get(complete.runId);
    assert.equal(firstReceipt.status, "complete");
    assert.equal(firstReceipt.evidence_content_hash, complete.evidence.sha256);
    assert.equal(database.prepare("SELECT sha256 FROM source_artifacts WHERE artifact_id = ?").get(firstReceipt.source_artifact_id).sha256, complete.evidence.sha256);
    assert.equal(database.prepare("SELECT started_at FROM collection_runs WHERE run_id = ?").get(complete.runId).started_at, complete.manifest.startedAt);
    const firstUpdatedAt = database.prepare("SELECT updated_at FROM companies WHERE company_id = 'cmp_place_1234567890'").get().updated_at;
    database.close();

    const duplicate = processor.ingestNaverRun(complete.event);
    assert.equal(duplicate.unchanged, true);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    assert.deepEqual({
      runs: count(database, "collection_runs"),
      artifacts: count(database, "source_artifacts"),
      observations: count(database, "company_observations"),
      current: count(database, "company_observation_current"),
      receipts: count(database, "collection_receipts")
    }, countsAfterFirst, "같은 회차를 다시 반영해도 행 수가 늘면 안 됩니다.");
    assert.equal(database.prepare("SELECT updated_at FROM companies WHERE company_id = 'cmp_place_1234567890'").get().updated_at, firstUpdatedAt);
    database.close();

    const rollbackRun = fixtureRun(dataDir, outputsDir, "fixture_transaction_rollback", {
      collectedAt: "2026-08-30T02:00:00.000Z",
      observation: {
        observationId: complete.observations[0].observationId,
        price: "159,000원"
      }
    });
    assert.throws(
      () => processor.ingestNaverRun(rollbackRun.event),
      (error) => error.code === "immutable_company_observation_conflict"
    );
    database = openMasterDatabase(databasePath);
    applySchema(database);
    assert.equal(database.prepare("SELECT 1 AS present FROM collection_runs WHERE run_id = ?").get(rollbackRun.runId), undefined,
      "관측 반입 중 실패하면 collection run까지 rollback되어야 합니다.");
    assert.equal(database.prepare("SELECT 1 AS present FROM collection_receipts WHERE run_id = ?").get(rollbackRun.runId), undefined,
      "관측 반입 중 실패하면 receipt가 남으면 안 됩니다.");
    assert.deepEqual({
      runs: count(database, "collection_runs"),
      artifacts: count(database, "source_artifacts"),
      observations: count(database, "company_observations"),
      current: count(database, "company_observation_current"),
      receipts: count(database, "collection_receipts")
    }, countsAfterFirst, "실패한 shadow 반입은 기존 good snapshot과 DB 행을 변경하면 안 됩니다.");
    database.close();

    fs.writeFileSync(path.join(complete.runDir, complete.resultName), "tampered", "utf8");
    assert.throws(() => processor.ingestNaverRun(complete.event), (error) => error.code === "run_output_artifact_conflict");
    fs.writeFileSync(path.join(complete.runDir, complete.resultName), complete.resultText, "utf8");

    const olderRun = fixtureRun(dataDir, outputsDir, "fixture_older_20260829", { collectedAt: "2026-08-29T01:00:00.000Z" });
    processor.ingestNaverRun(olderRun.event);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    const latestCompanyRun = database.prepare("SELECT latest_run_id, last_seen_at FROM companies WHERE company_id = 'cmp_place_1234567890'").get();
    assert.equal(latestCompanyRun.latest_run_id, complete.runId);
    assert.equal(latestCompanyRun.last_seen_at, "2026-08-30T01:00:00.000Z");
    database.close();

    writeJson(complete.manifestPath, { ...complete.manifest, searchKeyword: "변조된 검색어" });
    assert.throws(
      () => processor.ingestNaverRun({ ...complete.event, manifestSha256: sha256File(complete.manifestPath) }),
      (error) => error.code === "run_manifest_conflict"
    );
    writeJson(complete.manifestPath, complete.manifest);

    const noEvidence = fixtureRun(dataDir, outputsDir, "fixture_no_evidence_20260830", { noEvidence: true });
    const noEvidenceResult = processor.ingestNaverRun(noEvidence.event);
    assert.equal(noEvidenceResult.observationStatus, "partial");
    assert.equal(noEvidenceResult.observations, 0);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    const noEvidenceReceipt = database.prepare("SELECT status, reason_code FROM collection_receipts WHERE run_id = ?").get(noEvidence.runId);
    assert.equal(noEvidenceReceipt.status, "partial");
    assert.equal(noEvidenceReceipt.reason_code, "immutable_history_evidence_missing");
    database.close();

    const recoveredNoEvidence = historyEvidence(dataDir, noEvidence.runId, noEvidence.observations);
    const recoveredByReconcile = processor.reconcile({ limit: 200 });
    assert.ok(recoveredByReconcile.results.some((result) => result.runId === noEvidence.runId && result.observations === 1));
    database = openMasterDatabase(databasePath);
    applySchema(database);
    const recoveredNoEvidenceReceipt = database.prepare(`
      SELECT status
      FROM collection_receipts
      WHERE run_id = ? AND evidence_content_hash = ?
    `).get(noEvidence.runId, recoveredNoEvidence.sha256);
    assert.equal(recoveredNoEvidenceReceipt?.status, "complete", "partial 영수증 뒤 Evidence가 보완되면 재조정으로 정상 승격해야 합니다.");
    database.close();

    const repaired = fixtureRun(dataDir, outputsDir, "fixture_repaired_20260830", { missingResult: true });
    const beforeRepair = processor.ingestNaverRun(repaired.event);
    assert.equal(beforeRepair.status, "partial");
    assert.equal(beforeRepair.observations, 0);
    fs.writeFileSync(path.join(repaired.runDir, repaired.resultName), repaired.resultText, "utf8");
    const afterRepair = processor.ingestNaverRun(repaired.event);
    assert.equal(afterRepair.status, "complete");
    assert.equal(afterRepair.observations, 1);

    const countMismatch = fixtureRun(dataDir, outputsDir, "fixture_count_mismatch_20260830");
    const mismatchResult = processor.ingestNaverRun({ ...countMismatch.event, history: { ...countMismatch.event.history, appended: 2 } });
    assert.equal(mismatchResult.observationStatus, "partial");
    assert.equal(mismatchResult.observations, 0);
    const recoveredCount = processor.ingestNaverRun(countMismatch.event);
    assert.equal(recoveredCount.observationStatus, "complete");
    assert.equal(recoveredCount.observations, 1);

    const invalid = fixtureRun(dataDir, outputsDir, "fixture_invalid_inventory_20260830", {
      collectedAt: "2026-08-31T01:00:00.000Z",
      observation: { available: 9, sold: 6, saleRate: 0.6 }
    });
    const invalidResult = processor.ingestNaverRun(invalid.event);
    assert.equal(invalidResult.observations, 1, "불량 원자료도 감사 행으로는 보존합니다.");
    database = openMasterDatabase(databasePath);
    applySchema(database);
    assert.equal(database.prepare("SELECT status FROM company_observations WHERE run_id = ?").get(invalid.runId).status, "partial");
    const invalidReceipt = database.prepare("SELECT status, reason_code FROM collection_receipts WHERE run_id = ? AND company_id IS NOT NULL").get(invalid.runId);
    assert.equal(invalidReceipt.status, "partial");
    assert.equal(invalidReceipt.reason_code, "observation_quality_failed");
    const companyAfterInvalid = database.prepare("SELECT latest_run_id, last_seen_at FROM companies WHERE company_id = 'cmp_place_1234567890'").get();
    assert.equal(companyAfterInvalid.latest_run_id, countMismatch.runId, "불량 관측이 업체 최신 회차를 바꾸면 안 됩니다.");
    assert.equal(companyAfterInvalid.last_seen_at, "2026-08-30T01:00:00.000Z");
    database.close();

    const lowConfidence = fixtureRun(dataDir, outputsDir, "fixture_low_confidence_20260830", {
      collectedAt: "2026-09-01T01:00:00.000Z",
      observation: { inventoryConfidenceGrade: "C", inventoryConfidenceScore: 58 }
    });
    processor.ingestNaverRun(lowConfidence.event);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    assert.equal(database.prepare("SELECT status FROM company_observations WHERE run_id = ?").get(lowConfidence.runId).status, "partial");
    const companyAfterLowConfidence = database.prepare("SELECT latest_run_id, last_seen_at FROM companies WHERE company_id = 'cmp_place_1234567890'").get();
    assert.equal(companyAfterLowConfidence.latest_run_id, countMismatch.runId);
    assert.equal(companyAfterLowConfidence.last_seen_at, "2026-08-30T01:00:00.000Z");
    database.close();

    const basicRun = fixtureRun(dataDir, outputsDir, "fixture_basic_20260830", { noHistory: true, collectionPurpose: "basic_db", collectionProfile: "basic_db" });
    const basic = processor.ingestNaverRun(basicRun.event);
    assert.equal(basic.status, "complete");
    assert.equal(basic.observations, 0);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    const basicReceipt = database.prepare("SELECT status, reason_code FROM collection_receipts WHERE run_id = ?").get(basicRun.runId);
    assert.equal(basicReceipt.status, "complete");
    assert.equal(basicReceipt.reason_code, "history_not_applicable");
    database.close();

    const provisionalSancheong = fixtureRun(dataDir, outputsDir, "fixture_provisional_sancheong", {
      companyKey: "",
      companyName: "동명이숙소",
      sourceUrl: "",
      region: "산청"
    });
    const provisionalHapcheon = fixtureRun(dataDir, outputsDir, "fixture_provisional_hapcheon", {
      companyKey: "",
      companyName: "동명이숙소",
      sourceUrl: "",
      region: "합천"
    });
    processor.ingestNaverRun(provisionalSancheong.event);
    processor.ingestNaverRun(provisionalHapcheon.event);
    database = openMasterDatabase(databasePath);
    applySchema(database);
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM companies
      WHERE primary_name = '동명이숙소' AND status = 'review_required'
    `).get().count), 2, "Place ID가 없는 동명 업체를 지역 없이 자동 병합하면 안 됩니다.");
    database.close();

    const visitorSnapshot = {
      schemaVersion: 1,
      adapter: VISITOR_ADAPTER_VERSION,
      status: "ok",
      collectedAt: "2026-08-01T00:00:00.000Z",
      yearMonth: "202607",
      allRegions: JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "tourism_region_map.json"), "utf8")).regions.map((region) => ({
        regionKey: region.regionKey,
        yearMonth: "202607",
        visitorDays: 310000,
        averageDailyVisitors: 10000,
        coverageRate: 1,
        observedDays: 31,
        expectedDays: 31,
        categoryVisitorDays: { "1": 200000, "2": 100000, "3": 10000 },
        quality: { status: "complete" }
      })),
      quality: { status: "complete", validRowCount: 229 * 31 * 3 }
    };
    const visitorEvent = immutableTourismEvidence(dataDir, "visitors", visitorSnapshot);
    const tourism = processor.ingestTourismSnapshot(visitorEvent);
    assert.equal(tourism.status, "complete");
    assert.equal(tourism.metrics, visitorSnapshot.allRegions.length * 7);
    assert.equal(processor.ingestTourismSnapshot(visitorEvent).unchanged, true);

    const partialVisitorSnapshot = JSON.parse(JSON.stringify(visitorSnapshot));
    partialVisitorSnapshot.yearMonth = "202606";
    for (const row of partialVisitorSnapshot.allRegions) row.yearMonth = "202606";
    const partialVisitorRegion = partialVisitorSnapshot.allRegions.find((row) => row.regionKey === "kr_gyeongnam_hapcheon");
    partialVisitorRegion.coverageRate = 2;
    const partialVisitor = processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "visitors", partialVisitorSnapshot));
    assert.equal(partialVisitor.status, "partial");
    const hapcheonRegionId = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "region_master.json"), "utf8"))
      .units.find((row) => row.regionKey === "kr_gyeongnam_hapcheon").regionId;
    database = openMasterDatabase(databasePath);
    applySchema(database);
    const partialVisitorReceipt = database.prepare(`
      SELECT receipt.status
      FROM collection_receipts receipt
      WHERE receipt.source_id = 'kto_visitor_api'
        AND receipt.observed_period_start = '2026-06-01'
        AND receipt.region_id = ?
    `).get(hapcheonRegionId);
    assert.equal(partialVisitorReceipt.status, "partial");
    const invalidVisitorCurrent = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM region_metric_current current
      WHERE current.region_id = ?
        AND current.source_id = 'kto_visitor_api'
        AND current.period_start = '2026-06-01'
    `).get(hapcheonRegionId).count);
    assert.equal(invalidVisitorCurrent, 0, "부분 방문자 행을 현재값으로 승격하면 안 됩니다.");
    database.close();

    const truncatedVisitorSnapshot = JSON.parse(JSON.stringify(visitorSnapshot));
    truncatedVisitorSnapshot.yearMonth = "202605";
    truncatedVisitorSnapshot.allRegions = truncatedVisitorSnapshot.allRegions.slice(0, 1);
    truncatedVisitorSnapshot.allRegions[0].yearMonth = "202605";
    assert.throws(
      () => processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "visitors", truncatedVisitorSnapshot)),
      (error) => error.code === "tourism_snapshot_contract_failed"
    );

    const demandSnapshot = regionalSnapshot(DEMAND_STRENGTH_ADAPTER_VERSION, DEMAND_STRENGTH_OPERATIONS, { omitDetail: true });
    const demand = processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "demandStrength", demandSnapshot));
    assert.equal(demand.sourceId, "kto_demand_strength_api");
    assert.equal(demand.status, "partial", "수요강도 상세지표 누락은 전체값을 보존하되 품질은 partial입니다.");

    const resourceSnapshot = regionalSnapshot(RESOURCE_DEMAND_ADAPTER_VERSION, RESOURCE_DEMAND_OPERATIONS);
    const resource = processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "resourceDemand", resourceSnapshot));
    assert.equal(resource.sourceId, "kto_resource_demand_api");
    assert.equal(resource.status, "complete");

    const diversitySnapshot = regionalSnapshot(DIVERSITY_ADAPTER_VERSION, DIVERSITY_OPERATIONS);
    const diversity = processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "diversity", diversitySnapshot));
    assert.equal(diversity.sourceId, "kto_tourism_diversity_api");
    assert.equal(diversity.status, "complete");

    const badResource = regionalSnapshot(RESOURCE_DEMAND_ADAPTER_VERSION, RESOURCE_DEMAND_OPERATIONS, { badStatus: true });
    assert.throws(
      () => processor.ingestTourismSnapshot(immutableTourismEvidence(dataDir, "resourceDemand", badResource)),
      (error) => error.code === "tourism_snapshot_contract_failed"
    );

    database = openMasterDatabase(databasePath);
    applySchema(database);
    const tourismReceipt = database.prepare("SELECT status, evidence_content_hash FROM collection_receipts WHERE source_id = 'kto_visitor_api'").get();
    assert.equal(tourismReceipt.status, "complete");
    assert.equal(tourismReceipt.evidence_content_hash, visitorEvent.sha256);
    assert.equal(database.prepare("SELECT status FROM collection_receipts WHERE source_id = 'kto_demand_strength_api'").get().status, "partial");
    database.close();

    const baselineDataDir = path.join(temporaryDirectory, "baseline-data");
    const baselineOutputsDir = path.join(baselineDataDir, "outputs");
    const baselineDatabasePath = path.join(baselineDataDir, "master_db", "sabun_master.sqlite");
    const baselineRun = fixtureRun(baselineDataDir, baselineOutputsDir, "fixture_baseline_then_incremental");
    const baselineImport = applyImport({ dataDir: baselineDataDir, databasePath: baselineDatabasePath });
    assert.equal(baselineImport.counts.company_observations, 1);
    assert.equal(baselineImport.counts.company_observation_current, 1);
    const baselineProcessor = createMasterDbIncrementalProcessor({
      rootDir: ROOT,
      dataDir: baselineDataDir,
      outputsDir: baselineOutputsDir,
      databasePath: baselineDatabasePath
    });
    const baselineIncremental = baselineProcessor.ingestNaverRun(baselineRun.event);
    assert.equal(baselineIncremental.observations, 1, "초기 전체 반입 뒤 같은 회차 증분 반입이 충돌하면 안 됩니다.");
    database = openMasterDatabase(baselineDatabasePath);
    applySchema(database);
    assert.equal(count(database, "company_observations"), 1);
    assert.equal(count(database, "company_observation_current"), 1);
    assert.equal(count(database, "collection_receipts"), 1);
    database.close();

    const interruptedDataDir = path.join(temporaryDirectory, "interrupted-after-evidence");
    const interruptedOutputsDir = path.join(interruptedDataDir, "outputs");
    const interruptedDatabasePath = path.join(interruptedDataDir, "master_db", "sabun_master.sqlite");
    const interruptedRun = fixtureRun(interruptedDataDir, interruptedOutputsDir, "fixture_evidence_before_history_append");
    fs.rmSync(path.join(interruptedDataDir, "history", "observations.jsonl"));
    const interruptedProcessor = createMasterDbIncrementalProcessor({
      rootDir: ROOT,
      dataDir: interruptedDataDir,
      outputsDir: interruptedOutputsDir,
      databasePath: interruptedDatabasePath
    });
    const recoveredAfterInterruption = interruptedProcessor.reconcile({ limit: 10 });
    assert.equal(recoveredAfterInterruption.status, "complete");
    database = openMasterDatabase(interruptedDatabasePath);
    applySchema(database);
    assert.equal(count(database, "company_observations"), 1, "append 전 중단돼도 불변 Evidence로 관측을 복구해야 합니다.");
    assert.equal(count(database, "company_observation_current"), 1, "복구된 완전 관측은 current로 승격되어야 합니다.");
    assert.equal(database.prepare("SELECT status FROM collection_receipts WHERE run_id = ?").get(interruptedRun.runId).status, "complete");
    database.close();

    const queueDatabasePath = path.join(dataDir, "master_db", "queue.sqlite");
    const queue = createMasterDbDualWriteQueue({ rootDir: ROOT, dataDir, outputsDir, databasePath: queueDatabasePath, mode: "shadow", isRenderRuntime: false, logger: { warn() {} } });
    assert.equal(queue.enqueue(complete.event).status, "queued");
    assert.equal(queue.enqueue(complete.event).status, "duplicate");
    const queueStatus = await queue.flush();
    assert.equal(queueStatus.active, false);
    assert.equal(queueStatus.queued, 0);
    assert.equal(queueStatus.lastError, null);
    assert.equal(fs.existsSync(queueDatabasePath), true);
    database = openMasterDatabase(queueDatabasePath);
    applySchema(database);
    assert.equal(count(database, "company_observations"), 1, "child queue가 실제 관측을 기록해야 합니다.");
    assert.equal(count(database, "company_observation_current"), 1);
    database.close();
    queue.stop();

    const drainDataDir = path.join(temporaryDirectory, "drain-data");
    const drainOutputsDir = path.join(drainDataDir, "outputs");
    const drainDatabasePath = path.join(drainDataDir, "master_db", "sabun_master.sqlite");
    for (let index = 1; index <= 3; index += 1) {
      const run = fixtureRun(drainDataDir, drainOutputsDir, `fixture_reconcile_drain_${index}`, {
        noHistory: true,
        collectionPurpose: "basic_db",
        collectionProfile: "basic_db"
      });
      const timestamp = new Date(`2026-08-${20 + index}T00:00:00.000Z`);
      fs.utimesSync(run.manifestPath, timestamp, timestamp);
    }
    const drainQueue = createMasterDbDualWriteQueue({
      rootDir: ROOT,
      dataDir: drainDataDir,
      outputsDir: drainOutputsDir,
      databasePath: drainDatabasePath,
      mode: "shadow",
      isRenderRuntime: false,
      logger: { warn() {} }
    });
    assert.equal(drainQueue.reconcile(1).status, "queued");
    const drainStatus = await drainQueue.flush();
    assert.equal(drainStatus.lastError, null);
    assert.equal(drainStatus.lastResult?.result?.hasMore, false);
    database = openMasterDatabase(drainDatabasePath);
    applySchema(database);
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM collection_receipts
      WHERE source_id = 'naver_place' AND reason_code = 'history_not_applicable'
    `).get().count), 3, "재조정 batch가 미반영 회차를 남김없이 이어서 처리해야 합니다.");
    database.close();
    drainQueue.stop();

    const failedReconcileDataDir = path.join(temporaryDirectory, "failed-reconcile-data");
    const failedReconcileOutputsDir = path.join(failedReconcileDataDir, "outputs", "broken_run");
    fs.mkdirSync(failedReconcileOutputsDir, { recursive: true });
    fs.writeFileSync(path.join(failedReconcileOutputsDir, "manifest.json"), "{\n", "utf8");
    fs.utimesSync(
      path.join(failedReconcileOutputsDir, "manifest.json"),
      new Date("2026-08-20T00:00:00.000Z"),
      new Date("2026-08-20T00:00:00.000Z")
    );
    const validAfterBroken = fixtureRun(
      failedReconcileDataDir,
      path.join(failedReconcileDataDir, "outputs"),
      "valid_after_broken",
      { noHistory: true, collectionPurpose: "basic_db", collectionProfile: "basic_db" }
    );
    fs.utimesSync(
      validAfterBroken.manifestPath,
      new Date("2026-08-21T00:00:00.000Z"),
      new Date("2026-08-21T00:00:00.000Z")
    );
    const failedReconcileQueue = createMasterDbDualWriteQueue({
      rootDir: ROOT,
      dataDir: failedReconcileDataDir,
      outputsDir: path.join(failedReconcileDataDir, "outputs"),
      databasePath: path.join(failedReconcileDataDir, "master_db", "sabun_master.sqlite"),
      mode: "shadow",
      isRenderRuntime: false,
      logger: { warn() {} }
    });
    assert.equal(failedReconcileQueue.reconcile(1).status, "queued");
    const failedReconcileStatus = await failedReconcileQueue.flush();
    assert.equal(failedReconcileStatus.lastError, null, "불량 Evidence를 건너뛴 다음 정상 회차까지 이어서 처리해야 합니다.");
    assert.equal(failedReconcileStatus.lastFailure?.code, "master_db_reconcile_partial");
    database = openMasterDatabase(path.join(failedReconcileDataDir, "master_db", "sabun_master.sqlite"));
    applySchema(database);
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM collection_receipts
      WHERE run_id = 'valid_after_broken' AND status = 'complete'
    `).get().count), 1, "선두의 불량 manifest가 뒤 정상 회차를 막으면 안 됩니다.");
    database.close();
    failedReconcileQueue.stop();

    const failedTourismDataDir = path.join(temporaryDirectory, "failed-tourism-reconcile-data");
    const failedTourismOutputsDir = path.join(failedTourismDataDir, "outputs");
    fs.mkdirSync(failedTourismOutputsDir, { recursive: true });
    const invalidTourismText = "{\n";
    const invalidTourismSha = crypto.createHash("sha256").update(invalidTourismText).digest("hex");
    const invalidTourismPath = path.join(
      failedTourismDataDir,
      "tourism_data",
      "evidence",
      "cache_snapshots",
      "resourceDemand",
      `${invalidTourismSha}.json`
    );
    fs.mkdirSync(path.dirname(invalidTourismPath), { recursive: true });
    fs.writeFileSync(invalidTourismPath, invalidTourismText, "utf8");
    fs.utimesSync(invalidTourismPath, new Date("2026-08-20T00:00:00.000Z"), new Date("2026-08-20T00:00:00.000Z"));
    const validTourismAfterBroken = immutableTourismEvidence(
      failedTourismDataDir,
      "resourceDemand",
      regionalSnapshot(RESOURCE_DEMAND_ADAPTER_VERSION, RESOURCE_DEMAND_OPERATIONS, {
        yearMonth: "202608",
        regionKey: "kr_gyeongnam_hapcheon"
      })
    );
    fs.utimesSync(
      validTourismAfterBroken.evidencePath,
      new Date("2026-08-21T00:00:00.000Z"),
      new Date("2026-08-21T00:00:00.000Z")
    );
    const failedTourismQueue = createMasterDbDualWriteQueue({
      rootDir: ROOT,
      dataDir: failedTourismDataDir,
      outputsDir: failedTourismOutputsDir,
      databasePath: path.join(failedTourismDataDir, "master_db", "sabun_master.sqlite"),
      mode: "shadow",
      isRenderRuntime: false,
      logger: { warn() {} }
    });
    assert.equal(failedTourismQueue.reconcile(1).status, "queued");
    const failedTourismStatus = await failedTourismQueue.flush();
    assert.equal(failedTourismStatus.lastError, null);
    assert.equal(failedTourismStatus.lastFailure?.code, "master_db_reconcile_partial");
    database = openMasterDatabase(path.join(failedTourismDataDir, "master_db", "sabun_master.sqlite"));
    applySchema(database);
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM collection_receipts
      WHERE evidence_content_hash = ? AND status = 'complete'
    `).get(validTourismAfterBroken.sha256).count), 1, "불량 관광 Evidence 뒤 정상 Snapshot도 계속 처리해야 합니다.");
    database.close();
    failedTourismQueue.stop();

    console.log("master DB incremental tests passed");
  } finally {
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      // Windows can briefly retain SQLite/WAL handles after a child worker exits.
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
