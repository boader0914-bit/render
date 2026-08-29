const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, openMasterDatabase } = require("./master_db.cjs");
const {
  AUDIT_SCHEMA_VERSION,
  parseArguments,
  isPathInside,
  mountInfoPathInsideLiveDisk,
  sourceManifest,
  expectedTrailingMonths,
  commonTrailingMonthWindow,
  latestClosedYearMonth,
  oldestAllowedRegionMonth,
  compareRegionReference,
  databaseAudit,
  runAudit,
  cleanupTemporaryAudit
} = require("./master_db_baseline_audit.cjs");

function writeTourismCacheSnapshot(cacheDir, fileName, snapshot) {
  fs.writeFileSync(path.join(cacheDir, fileName), JSON.stringify(snapshot, null, 2), "utf8");
}

function regionalOperationSnapshot(adapter, yearMonth, operationKey, regionKey = "kr_gyeongnam_sancheong") {
  return {
    schemaVersion: "tourism-regional-snapshot-v1",
    adapter,
    status: "complete",
    yearMonth,
    collectedAt: "2026-08-30T00:00:00.000Z",
    region: { regionKey },
    operations: {
      [operationKey]: {
        status: "complete",
        metrics: [{ code: "overall", value: 100 }]
      }
    }
  };
}

function writeTrailingRegionalAuditFixture(cacheDir, months) {
  for (const yearMonth of months) {
    const visitorRows = [{
      regionKey: "kr_gyeongnam_sancheong",
      visitorDays: 310000,
      averageDailyVisitors: 10000,
      coverageRate: 1,
      observedDays: 31,
      categoryVisitorDays: { "1": 100000, "2": 110000, "3": 100000 },
      quality: { status: "complete" }
    }];
    if (yearMonth === months[0]) {
      visitorRows.push({
        regionKey: "kr_unexpected_recent_region",
        visitorDays: 1,
        averageDailyVisitors: 1,
        coverageRate: 1,
        observedDays: 1,
        categoryVisitorDays: {},
        quality: { status: "complete" }
      });
    }
    writeTourismCacheSnapshot(cacheDir, `visitors__audit__${yearMonth}.json`, {
      schemaVersion: "tourism-visitor-snapshot-v1",
      adapter: "locgo-regn-visitors-v1",
      status: "complete",
      yearMonth,
      collectedAt: "2026-08-30T00:00:00.000Z",
      allRegions: visitorRows
    });
    writeTourismCacheSnapshot(
      cacheDir,
      `demand-strength__audit__${yearMonth}.json`,
      regionalOperationSnapshot("area-tar-dem-ds-v1", yearMonth, "demand")
    );
    writeTourismCacheSnapshot(
      cacheDir,
      `resource-demand__audit__${yearMonth}.json`,
      regionalOperationSnapshot("area-tar-res-dem-v3", yearMonth, "resource")
    );
    writeTourismCacheSnapshot(
      cacheDir,
      `diversity__audit__${yearMonth}.json`,
      regionalOperationSnapshot("area-tar-div-v3", yearMonth, "diversity")
    );
  }
}

function run() {
  assert.equal(latestClosedYearMonth(new Date("2026-08-30T03:00:00.000Z")), "202607");
  assert.equal(oldestAllowedRegionMonth(new Date("2026-08-30T03:00:00.000Z"), 1), "202606");
  const completeMonths = expectedTrailingMonths("202607", 12);
  const fourSourceWindow = commonTrailingMonthWindow({
    kto_visitor_api: completeMonths,
    kto_demand_strength_api: completeMonths,
    kto_resource_demand_api: completeMonths,
    kto_tourism_diversity_api: completeMonths
  });
  assert.equal(fourSourceWindow.latestCommonMonth, "202607");
  assert.equal(fourSourceWindow.months.length, 12);
  assert.deepEqual(Object.values(fourSourceWindow.missingBySource), [[], [], [], []]);
  const gappedWindow = commonTrailingMonthWindow({
    kto_visitor_api: completeMonths,
    kto_demand_strength_api: completeMonths.filter((month) => month !== "202601"),
    kto_resource_demand_api: completeMonths,
    kto_tourism_diversity_api: completeMonths
  });
  assert.deepEqual(gappedWindow.missingBySource.kto_demand_strength_api, ["202601"],
    "관광 4종 중 한 출처의 연속 12개월 공백을 잡아야 합니다.");
  const tourismRegionMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "tourism_region_map.json"), "utf8"));
  const tourismRegionKeys = tourismRegionMap.regions.map((region) => region.regionKey);
  assert.equal(tourismRegionKeys.length, 229);
  assert.equal(new Set(tourismRegionKeys).size, 229, "방문자 월별 기대 지역은 중복 없는 229개여야 합니다.");
  const mountInfoFixture = [
    "36 25 8:1 / / rw,relatime - ext4 /dev/root rw",
    "40 36 8:2 / /var/data rw,relatime - ext4 /dev/render-disk rw",
    "41 36 8:2 /tourism_data /tmp/audit-alias rw,relatime - ext4 /dev/render-disk rw"
  ].join("\n");
  assert.equal(mountInfoPathInsideLiveDisk("/tmp/audit-alias/cache/audit.sqlite", mountInfoFixture), true);
  assert.equal(mountInfoPathInsideLiveDisk("/tmp/safe-audit/audit.sqlite", mountInfoFixture), false);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sabun-master-audit-test-"));
  try {
    const realSourceDirectory = path.join(temporaryDirectory, "real-source");
    const sourceAliasDirectory = path.join(temporaryDirectory, "source-alias");
    fs.mkdirSync(realSourceDirectory, { recursive: true });
    fs.symlinkSync(realSourceDirectory, sourceAliasDirectory, process.platform === "win32" ? "junction" : "dir");
    assert.equal(isPathInside(realSourceDirectory, path.join(sourceAliasDirectory, "audit.sqlite")), true);
    assert.throws(
      () => runAudit({
        dataDir: realSourceDirectory,
        databasePath: path.join(sourceAliasDirectory, "nested", "audit.sqlite")
      }),
      (error) => error.code === "baseline_database_inside_source",
      "원본 하위 디렉터리를 가리키는 symlink 경유 DB 경로도 차단해야 합니다."
    );
    const danglingTarget = path.join(realSourceDirectory, "future-audit.sqlite");
    const danglingLink = path.join(temporaryDirectory, "dangling-audit.sqlite");
    try {
      fs.symlinkSync(danglingTarget, danglingLink, "file");
      assert.equal(fs.existsSync(danglingLink), false);
      assert.equal(isPathInside(realSourceDirectory, danglingLink), true,
        "아직 없는 원본 내부 파일을 가리키는 dangling symlink도 차단해야 합니다.");
    } catch (error) {
      if (!(process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code))) throw error;
    }

    const databasePath = path.join(temporaryDirectory, "repo-audit", "sabun_master.sqlite");
    const report = runAudit({ dataDir: ROOT, databasePath });
    assert.equal(report.schemaVersion, AUDIT_SCHEMA_VERSION);
    assert.equal(report.status, "review_required", "저장소에는 산청 관광 cache가 없어 대표 지역만 검토대기여야 합니다.");
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.reviewRequired, ["known_null_omissions", "deferred_legacy_reviews", "region_reference"]);
    assert.equal(report.source.stable, true);
    assert.equal(report.firstApply.processed.artifacts, report.source.before.fileCount);
    assert.equal(report.firstApply.counts.source_artifacts, report.source.before.fileCount);
    assert.deepEqual(report.firstApply.counts, report.secondApply.counts);
    assert.deepEqual(report.database.integrity, ["ok"]);
    assert.deepEqual(report.database.foreignKeyFailures, []);
    assert.deepEqual(report.database.quality, {
      companyCurrentRows: 91,
      companyCurrentExpected: 91,
      companyCurrentMissing: 0,
      companyCurrentPointerInvalid: 0,
      companyCurrentInvalid: 0,
      regionCurrentRows: 2271,
      regionCurrentExpected: 2271,
      regionCurrentMissing: 0,
      regionCurrentPointerInvalid: 0,
      regionCurrentInvalid: 0,
      keywordCurrentRows: 180,
      keywordCurrentExpected: 180,
      keywordCurrentMissing: 0,
      keywordCurrentPointerInvalid: 0,
      keywordCurrentInvalid: 0
    });
    assert.equal(report.database.artifactCoverage.missing.length, 0);
    assert.equal(report.database.rejectedLedgerRows, 0);
    assert.equal(report.database.unsafeLedgerRows, 0);
    assert.equal(report.database.importedWithoutTarget, 0);
    assert.equal(report.database.missingLedgerTargetRows, 0);
    assert.equal(report.database.knownNullOmissionRows, 51);
    assert.equal(report.database.deferredReviewRows, 22);
    assert.equal(report.database.references.company.status, "pass");
    assert.equal(report.database.references.company.sourceRows, 7);
    assert.equal(report.database.references.region.status, "unavailable");
    assert.equal(report.checks.find((check) => check.name === "region_metric_count")?.passed, true);
    assert.equal(report.checks.find((check) => check.name === "keyword_metric_count")?.passed, true);
    assert.equal(fs.existsSync(databasePath), true);

    const alteredDatabase = openMasterDatabase(databasePath);
    try {
      const pointerMetadata = alteredDatabase.prepare(`
        SELECT pointer.rowid, pointer.status_rank, pointer.has_value, pointer.collected_at,
               observation.status_rank AS expected_status_rank,
               CASE WHEN observation.rank_value IS NOT NULL
                          OR observation.supply IS NOT NULL OR observation.available IS NOT NULL OR observation.sold IS NOT NULL
                          OR observation.sale_rate IS NOT NULL OR observation.price_num IS NOT NULL
                          OR NULLIF(TRIM(COALESCE(observation.price_text, '')), '') IS NOT NULL
                    THEN 1 ELSE 0 END AS expected_has_value,
               observation.collected_at AS expected_collected_at
        FROM company_observation_current pointer
        JOIN company_observations observation ON observation.observation_id = pointer.observation_id
        LIMIT 1
      `).get();
      alteredDatabase.prepare(`
        UPDATE company_observation_current
        SET status_rank = ?, has_value = ?, collected_at = ?
        WHERE rowid = ?
      `).run(pointerMetadata.status_rank - 1, pointerMetadata.has_value ? 0 : 1, "1900-01-01T00:00:00.000Z", pointerMetadata.rowid);
      const pointerMetadataChecks = databaseAudit(alteredDatabase, sourceManifest(ROOT), ROOT);
      assert.ok(pointerMetadataChecks.quality.companyCurrentPointerInvalid > 0,
        "current pointer의 상태우선순위, 값 유무, 수집시각 복제값 불일치를 잡아야 합니다.");
      alteredDatabase.prepare(`
        UPDATE company_observation_current
        SET status_rank = ?, has_value = ?, collected_at = ?
        WHERE rowid = ?
      `).run(
        pointerMetadata.expected_status_rank,
        pointerMetadata.expected_has_value,
        pointerMetadata.expected_collected_at,
        pointerMetadata.rowid
      );

      const latestPointer = alteredDatabase.prepare(`
        SELECT pointer.rowid AS pointer_rowid, observation.*
        FROM company_observation_current pointer
        JOIN company_observations observation ON observation.observation_id = pointer.observation_id
        WHERE observation.status = 'complete'
          AND observation.confidence_grade IN ('A', 'B')
          AND observation.confidence_score >= 70
        LIMIT 1
      `).get();
      alteredDatabase.prepare(`
        INSERT INTO company_observations (
          observation_id, run_id, company_id, keyword_id, source_id, channel_code,
          collected_at, stay_date, lead_time_days, rank_value, product_key, product_type,
          inventory_group, supply, available, sold, sale_rate, price_num, price_text,
          status, status_rank, confidence_grade, confidence_score, source_url,
          source_artifact_id, content_hash, raw_json, updated_at
        )
        SELECT 'co_older_pointer_audit', run_id, company_id, keyword_id, source_id, channel_code,
               '1900-01-01T00:00:00.000Z', stay_date, lead_time_days, rank_value, product_key, product_type,
               inventory_group, supply, available, sold, sale_rate, price_num, price_text,
               status, status_rank, confidence_grade, confidence_score, source_url,
               source_artifact_id, content_hash || '_older', raw_json, updated_at
        FROM company_observations
        WHERE observation_id = ?
      `).run(latestPointer.observation_id);
      alteredDatabase.prepare(`
        UPDATE company_observation_current
        SET observation_id = 'co_older_pointer_audit', collected_at = '1900-01-01T00:00:00.000Z'
        WHERE rowid = ?
      `).run(latestPointer.pointer_rowid);
      const olderPointerChecks = databaseAudit(alteredDatabase, sourceManifest(ROOT), ROOT);
      assert.ok(olderPointerChecks.quality.companyCurrentPointerInvalid > 0,
        "같은 natural key에서 최신 관측 대신 과거 관측을 가리키는 pointer를 잡아야 합니다.");
      alteredDatabase.prepare(`
        UPDATE company_observation_current
        SET observation_id = ?, collected_at = ?
        WHERE rowid = ?
      `).run(latestPointer.observation_id, latestPointer.collected_at, latestPointer.pointer_rowid);
      alteredDatabase.prepare("DELETE FROM company_observations WHERE observation_id = 'co_older_pointer_audit'").run();

      const companyPointers = alteredDatabase.prepare(`
        SELECT company_id, stay_date, product_key, channel_code, inventory_group, source_id, observation_id
        FROM company_observation_current
        ORDER BY company_id, stay_date, product_key
        LIMIT 2
      `).all();
      assert.equal(companyPointers.length, 2);
      alteredDatabase.prepare(`
        UPDATE company_observation_current
        SET observation_id = ?
        WHERE company_id = ? AND stay_date = ? AND product_key = ?
          AND channel_code = ? AND inventory_group = ? AND source_id = ?
      `).run(
        companyPointers[1].observation_id,
        companyPointers[0].company_id,
        companyPointers[0].stay_date,
        companyPointers[0].product_key,
        companyPointers[0].channel_code,
        companyPointers[0].inventory_group,
        companyPointers[0].source_id
      );
      alteredDatabase.prepare(`
        DELETE FROM keyword_metric_current
        WHERE rowid = (SELECT rowid FROM keyword_metric_current LIMIT 1)
      `).run();
      alteredDatabase.prepare(`
        UPDATE legacy_import_ledger
        SET target_table = 'companies'
        WHERE rowid = (
          SELECT rowid FROM legacy_import_ledger
          WHERE import_status = 'skipped' AND reason = 'null_metric_value'
          LIMIT 1
        )
      `).run();
      alteredDatabase.prepare(`
        UPDATE legacy_import_ledger
        SET target_record_id = 'ghost_company'
        WHERE rowid = (
          SELECT rowid FROM legacy_import_ledger
          WHERE import_status = 'imported' AND target_table = 'companies'
          LIMIT 1
        )
      `).run();
      const artifactId = alteredDatabase.prepare("SELECT artifact_id FROM source_artifacts LIMIT 1").get().artifact_id;
      alteredDatabase.prepare(`
        INSERT INTO legacy_import_ledger (
          ledger_id, source_artifact_id, legacy_record_key, target_table,
          target_record_id, import_status, reason, imported_at
        ) VALUES ('ledger_ghost_audit', ?, 'ghost', 'ghost_table', 'ghost_record', 'imported', NULL, ?)
      `).run(artifactId, new Date().toISOString());
      const existingCompanyId = alteredDatabase.prepare("SELECT company_id FROM companies LIMIT 1").get().company_id;
      alteredDatabase.prepare(`
        INSERT INTO legacy_import_ledger (
          ledger_id, source_artifact_id, legacy_record_key, target_table,
          target_record_id, import_status, reason, imported_at
        ) VALUES ('ledger_failed_audit', ?, 'failed', 'companies', ?, 'failed', NULL, ?)
      `).run(artifactId, existingCompanyId, new Date().toISOString());
      alteredDatabase.prepare(`
        UPDATE legacy_import_ledger
        SET target_record_id = NULL
        WHERE rowid = (
          SELECT rowid FROM legacy_import_ledger
          WHERE import_status = 'review_required'
          LIMIT 1
        )
      `).run();
      const alteredChecks = databaseAudit(alteredDatabase, sourceManifest(ROOT), ROOT);
      assert.ok(alteredChecks.quality.companyCurrentPointerInvalid > 0, "다른 업체 관측을 가리키는 current pointer를 잡아야 합니다.");
      assert.equal(alteredChecks.quality.keywordCurrentMissing, 1, "누락된 keyword current를 잡아야 합니다.");
      assert.ok(alteredChecks.unsafeLedgerRows > 0, "허용되지 않은 ledger 대상 테이블을 잡아야 합니다.");
      assert.ok(alteredChecks.blockedLedgerStatusRows > 0, "failed/error/unknown ledger 상태를 잡아야 합니다.");
      assert.ok(alteredChecks.requiredTargetMissing > 0, "대상 필수 ledger의 빈 target_record_id를 잡아야 합니다.");
      assert.ok(alteredChecks.missingLedgerTargetRows > 0, "존재하지 않는 ledger 대상 ID를 잡아야 합니다.");
      alteredDatabase.exec(`
        DELETE FROM region_metric_current;
        DELETE FROM region_metric_observations;
        DELETE FROM keyword_metric_current;
        DELETE FROM keyword_metric_observations;
      `);
      const deletedMetricChecks = databaseAudit(alteredDatabase, sourceManifest(ROOT), ROOT);
      assert.equal(deletedMetricChecks.quality.regionCurrentRows, 0);
      assert.equal(deletedMetricChecks.quality.regionCurrentExpected, 0);
      assert.equal(deletedMetricChecks.quality.keywordCurrentRows, 0);
      assert.equal(deletedMetricChecks.quality.keywordCurrentExpected, 0);
      assert.ok(deletedMetricChecks.missingLedgerTargetRows >= 2451,
        "region/keyword 관측과 current가 함께 삭제돼도 ledger 실재 대조로 실패해야 합니다.");
    } finally {
      alteredDatabase.close();
    }

    const partialRegionDataDir = path.join(temporaryDirectory, "partial-region-source");
    const partialRegionCacheDir = path.join(partialRegionDataDir, "tourism_data", "cache");
    fs.mkdirSync(partialRegionCacheDir, { recursive: true });
    fs.writeFileSync(path.join(partialRegionCacheDir, "visitors__partial__202608.json"), JSON.stringify({
      schemaVersion: "tourism-visitor-snapshot-v1",
      adapter: "locgo-regn-visitors-v1",
      status: "ok",
      yearMonth: "202608",
      collectedAt: "2026-08-30T00:00:00.000Z",
      allRegions: [{
        regionKey: "kr_gyeongnam_sancheong",
        visitorDays: 310000,
        averageDailyVisitors: 10000,
        coverageRate: 1,
        observedDays: 31,
        categoryVisitorDays: { "1": 100000, "2": 110000, "3": 100000 },
        quality: { status: "complete" }
      }]
    }, null, 2), "utf8");
    const partialRegionReport = runAudit({
      dataDir: partialRegionDataDir,
      databasePath: path.join(temporaryDirectory, "partial-region-audit", "sabun_master.sqlite")
    });
    assert.equal(partialRegionReport.status, "fail");
    assert.ok(partialRegionReport.failures.includes("region_reference"));
    assert.equal(partialRegionReport.database.references.region.status, "mismatch");
    assert.ok(partialRegionReport.database.references.region.mismatches.some((item) => (
      item.reason === "common_trailing_12_month_window_missing"
        || item.reason === "national_region_coverage_incomplete"
    )));
    const trailingWindowDataDir = path.join(temporaryDirectory, "trailing-window-source");
    const trailingWindowCacheDir = path.join(trailingWindowDataDir, "tourism_data", "cache");
    fs.mkdirSync(trailingWindowCacheDir, { recursive: true });
    const trailingMonths = expectedTrailingMonths("202607", 12);
    writeTrailingRegionalAuditFixture(trailingWindowCacheDir, trailingMonths);
    const oldLegacyFileName = "visitors__legacy-incomplete__202507.json";
    writeTourismCacheSnapshot(trailingWindowCacheDir, oldLegacyFileName, {
      schemaVersion: "tourism-visitor-snapshot-v1",
      adapter: "locgo-regn-visitors-v1",
      status: "partial",
      yearMonth: "202507",
      collectedAt: "2025-08-01T00:00:00.000Z",
      allRegions: [{
        regionKey: "kr_legacy_region_removed_from_master",
        visitorDays: null,
        averageDailyVisitors: null,
        coverageRate: null,
        observedDays: null,
        quality: { status: "partial" }
      }]
    });
    const trailingWindowReport = runAudit({
      dataDir: trailingWindowDataDir,
      databasePath: path.join(temporaryDirectory, "trailing-window-audit", "sabun_master.sqlite")
    });
    const trailingReference = trailingWindowReport.database.references.region;
    assert.deepEqual(trailingReference.months, [...trailingMonths].sort());
    assert.equal(trailingReference.sourceFiles, 12 * 4,
      "감사 대조 파일은 공통 최근 12개월의 관광 4종만 선택해야 합니다.");
    assert.equal(trailingReference.mismatches.some((item) => item.file?.endsWith(oldLegacyFileName)), false,
      "13개월 이전 불완전·레거시 cache는 최근 12개월 감사에 영향을 주면 안 됩니다.");
    const recentCoverageMismatch = trailingReference.mismatches.find((item) => (
      item.reason === "national_region_coverage_incomplete"
      && item.sourceId === "kto_visitor_api"
      && item.yearMonth === "202607"
    ));
    assert.ok(recentCoverageMismatch?.missing?.includes("kr_gyeongnam_hapcheon"),
      "선택된 최근 12개월 안의 지역 누락은 계속 실패해야 합니다.");
    assert.ok(recentCoverageMismatch?.unexpected?.includes("kr_unexpected_recent_region"),
      "선택된 최근 12개월 안의 예상 밖 지역은 계속 실패해야 합니다.");
    assert.equal(trailingReference.status, "mismatch");
    const trailingWindowDatabase = openMasterDatabase(trailingWindowReport.database.path);
    try {
      const originalMetric = trailingWindowDatabase.prepare(`
        SELECT * FROM region_metric_observations
        ORDER BY observation_id
        LIMIT 1
      `).get();
      trailingWindowDatabase.prepare("DELETE FROM region_metric_current WHERE observation_id = ?").run(originalMetric.observation_id);
      trailingWindowDatabase.prepare("DELETE FROM region_metric_observations WHERE observation_id = ?").run(originalMetric.observation_id);
      const cloneMetric = trailingWindowDatabase.prepare(`
        SELECT * FROM region_metric_observations
        WHERE source_artifact_id = ?
        ORDER BY observation_id
        LIMIT 1
      `).get(originalMetric.source_artifact_id);
      trailingWindowDatabase.prepare(`
        INSERT INTO region_metric_observations (
          observation_id, run_id, region_id, source_id, metric_code, period_start, period_end,
          value_num, value_text, unit, status, status_rank, collected_at, source_artifact_id,
          quality_score, content_hash, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, 'unexpected_metric', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "rmo_unexpected_audit", cloneMetric.run_id, cloneMetric.region_id, cloneMetric.source_id,
        cloneMetric.period_start, cloneMetric.period_end, cloneMetric.value_num, cloneMetric.value_text,
        cloneMetric.unit, cloneMetric.status, cloneMetric.status_rank, cloneMetric.collected_at,
        cloneMetric.source_artifact_id, cloneMetric.quality_score, `${cloneMetric.content_hash}_unexpected`,
        cloneMetric.raw_json, cloneMetric.updated_at
      );
      const bidirectionalReference = compareRegionReference(trailingWindowDatabase, trailingWindowDataDir);
      const metricSetMismatch = bidirectionalReference.mismatches.find((item) => item.reason === "db_metric_set_mismatch");
      assert.ok(metricSetMismatch?.missing?.length, "원본에는 있고 DB에는 없는 지표를 잡아야 합니다.");
      assert.ok(metricSetMismatch?.unexpected?.length, "DB에만 있는 예상 밖 지표를 잡아야 합니다.");
    } finally {
      trailingWindowDatabase.close();
    }

    const logicalChangeReport = runAudit({
      dataDir: ROOT,
      databasePath: path.join(temporaryDirectory, "logical-change-audit", "sabun_master.sqlite"),
      onAfterFirstApply: ({ databasePath: changingDatabasePath }) => {
        const changingDatabase = openMasterDatabase(changingDatabasePath);
        try {
          changingDatabase.prepare(`
            UPDATE company_observations
            SET price_num = price_num + 1
            WHERE observation_id = (
              SELECT observation_id
              FROM company_observations
              WHERE company_id <> 'cmp_place_35644668' AND price_num IS NOT NULL
              LIMIT 1
            )
          `).run();
        } finally {
          changingDatabase.close();
        }
      }
    });
    assert.equal(logicalChangeReport.source.stable, true);
    assert.deepEqual(logicalChangeReport.firstApply.counts, logicalChangeReport.secondApply.counts);
    assert.equal(logicalChangeReport.idempotency.stable, false);
    assert.ok(logicalChangeReport.failures.includes("logical_content_stable"));

    const changingDataDir = path.join(temporaryDirectory, "changing-source");
    const changingHistoryDir = path.join(changingDataDir, "history");
    const changingDatabasePath = path.join(temporaryDirectory, "changing-audit", "sabun_master.sqlite");
    fs.mkdirSync(changingHistoryDir, { recursive: true });
    const changingHistoryFile = path.join(changingHistoryDir, "observations.jsonl");
    fs.writeFileSync(changingHistoryFile, "", "utf8");
    const changedReport = runAudit({
      dataDir: changingDataDir,
      databasePath: changingDatabasePath,
      onAfterFirstApply: () => fs.appendFileSync(changingHistoryFile, "\n", "utf8")
    });
    assert.equal(changedReport.status, "fail");
    assert.equal(changedReport.source.stable, false);
    assert.ok(changedReport.failures.includes("source_stable"));

    assert.throws(
      () => runAudit({ dataDir: ROOT, databasePath: path.join(ROOT, "master_db", "unsafe-audit.sqlite") }),
      (error) => error.code === "baseline_database_inside_source"
    );
    assert.throws(
      () => runAudit({
        dataDir: ROOT,
        databasePath: path.join(temporaryDirectory, "report-path-audit", "sabun_master.sqlite"),
        reportPath: path.join(ROOT, "unsafe-audit-report.json")
      }),
      (error) => error.code === "baseline_report_inside_source"
    );
    assert.throws(
      () => runAudit({
        dataDir: ROOT,
        databasePath: path.join(temporaryDirectory, "shadow-mode-audit", "sabun_master.sqlite"),
        env: { ...process.env, MASTER_DB_WRITE_MODE: "shadow" }
      }),
      (error) => error.code === "baseline_write_mode_must_be_off"
    );
    const unavailableDiskDatabasePath = path.join(temporaryDirectory, "disk-measurement-audit", "sabun_master.sqlite");
    assert.throws(
      () => runAudit({
        dataDir: ROOT,
        databasePath: unavailableDiskDatabasePath,
        freeBytesProvider: () => null
      }),
      (error) => error.code === "baseline_insufficient_free_space",
      "디스크 여유 측정 자체가 실패하면 반입 전에 차단해야 합니다."
    );
    assert.equal(fs.existsSync(unavailableDiskDatabasePath), false, "디스크 측정 실패 시 감사 DB를 만들면 안 됩니다.");
    assert.throws(
      () => runAudit({
        dataDir: ROOT,
        databasePath: path.join(temporaryDirectory, "unknown-mode-audit", "sabun_master.sqlite"),
        env: { ...process.env, MASTER_DB_WRITE_MODE: "future-mode" }
      }),
      (error) => error.code === "baseline_write_mode_must_be_off"
    );
    assert.throws(
      () => parseArguments(["--allow-live-source"]),
      /알 수 없는 옵션/
    );
    assert.throws(
      () => parseArguments(["--data-dir"]),
      /경로가 필요/
    );

    const temporaryReport = runAudit({ dataDir: ROOT });
    const generatedDirectory = temporaryReport.database.temporaryDirectory;
    assert.ok(generatedDirectory);
    cleanupTemporaryAudit(temporaryReport, false);
    assert.equal(fs.existsSync(generatedDirectory), false);
    assert.equal(temporaryReport.database.retained, false);

    console.log("master DB baseline audit tests passed");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

run();
