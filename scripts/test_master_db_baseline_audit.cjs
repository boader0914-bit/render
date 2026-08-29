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
  latestClosedYearMonth,
  oldestAllowedRegionMonth,
  databaseAudit,
  runAudit,
  cleanupTemporaryAudit
} = require("./master_db_baseline_audit.cjs");

function run() {
  assert.equal(latestClosedYearMonth(new Date("2026-08-30T03:00:00.000Z")), "202607");
  assert.equal(oldestAllowedRegionMonth(new Date("2026-08-30T03:00:00.000Z"), 1), "202606");
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
    assert.equal(fs.existsSync(databasePath), true);

    const alteredDatabase = openMasterDatabase(databasePath);
    try {
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
      const alteredChecks = databaseAudit(alteredDatabase, sourceManifest(ROOT), ROOT);
      assert.ok(alteredChecks.quality.companyCurrentPointerInvalid > 0, "다른 업체 관측을 가리키는 current pointer를 잡아야 합니다.");
      assert.equal(alteredChecks.quality.keywordCurrentMissing, 1, "누락된 keyword current를 잡아야 합니다.");
      assert.ok(alteredChecks.unsafeLedgerRows > 0, "허용되지 않은 ledger 대상 테이블을 잡아야 합니다.");
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
