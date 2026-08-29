const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ROOT,
  sha256File,
  numberOrNull,
  parsePrice,
  openMasterDatabase,
  applySchema,
  upsertRegionMetric
} = require("./master_db.cjs");
const {
  inspectInputs,
  applyImport,
  databaseCounts,
  redactSensitiveText,
  redactSensitive,
  storeCompanyExternalIdentity
} = require("./master_db_import.cjs");

function fileHashes(files) {
  return Object.fromEntries(files.map((filePath) => [filePath, sha256File(filePath)]));
}

function run() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sabun-master-db-"));
  const databasePath = path.join(temporaryDirectory, "sabun_master.sqlite");
  const protectedFiles = [
    path.join(ROOT, "company_master", "companies.json"),
    path.join(ROOT, "history", "observations.jsonl"),
    path.join(ROOT, "web", "data", "region_master.json"),
    path.join(ROOT, "web", "data", "tourism_region_map.json")
  ].filter((filePath) => fs.existsSync(filePath));
  const beforeHashes = fileHashes(protectedFiles);

  try {
    const dryRun = inspectInputs(ROOT);
    assert.equal(dryRun.existingFilesWillChange, false);
    assert.equal(dryRun.credentialsIncluded, false);
    assert.equal(dryRun.parseErrors.length, 0);
    assert.equal(dryRun.regions, 537);
    assert.equal(dryRun.tourismRegionMappings, 229);
    assert.equal(dryRun.companies, 22);
    assert.equal(dryRun.historyObservations, 105);
    assert.equal(fs.existsSync(databasePath), false, "dry-run이 DB 파일을 만들면 안 됩니다.");
    assert.equal(numberOrNull(null), null);
    assert.equal(numberOrNull(""), null);
    assert.equal(numberOrNull("자료 없음"), null);
    assert.equal(numberOrNull(0), 0);
    assert.equal(parsePrice(null), null);
    assert.equal(parsePrice("가격 미관측"), null);
    assert.equal(parsePrice("149,000원"), 149000);
    assert.equal(parsePrice("159,000~349,000원"), null);
    assert.equal(
      redactSensitiveText("문의 010-1234-5678, serviceKey=secret-value"),
      "문의 [redacted-phone], serviceKey=[redacted]"
    );
    assert.deepEqual(
      redactSensitive({ businessRegistrationNumber: "123", mobileCtr: 1.2, nested: { apiKey: "secret" } }),
      { businessRegistrationNumber: "[redacted]", mobileCtr: 1.2, nested: { apiKey: "[redacted]" } }
    );

    const first = applyImport({ dataDir: ROOT, databasePath });
    assert.equal(first.existingFilesChanged, false);
    assert.equal(first.credentialsIncluded, false);
    assert.equal(first.counts.administrative_regions, 538);
    assert.equal(first.counts.tourism_region_codes, 229);
    assert.equal(first.counts.companies, 22);
    assert.equal(first.counts.company_external_ids, 44);
    assert.equal(first.counts.company_match_candidates, 44);
    assert.equal(first.counts.company_observations, 105);
    assert.equal(first.counts.company_observation_current, 105);
    assert.equal(first.counts.company_snapshots, 22);
    assert.equal(first.counts.company_snapshot_pointers, 0);
    assert.equal(first.counts.company_channel_settings, 0);
    assert.equal(first.counts.company_product_observations, 0);
    assert.equal(first.counts.region_metric_observations, 2271);
    assert.equal(first.counts.region_metric_current, 2271);
    assert.equal(first.counts.keyword_metric_observations, 180);
    assert.equal(first.counts.keyword_metric_current, 180);
    assert.equal(first.counts.source_artifacts, 40);
    assert.ok(
      first.counts.legacy_import_ledger >= (
        first.counts.source_artifacts
        + first.counts.company_observations
        + first.counts.region_metric_observations
        + first.counts.keyword_metric_observations
      ),
      "파일뿐 아니라 각 관측행의 반입 결과도 ledger에 남아야 합니다."
    );

    const firstCounts = { ...first.counts };
    const second = applyImport({ dataDir: ROOT, databasePath });
    assert.deepEqual(second.counts, firstCounts, "같은 자료를 두 번 반입해도 행 수가 늘면 안 됩니다.");

    const database = openMasterDatabase(databasePath);
    try {
      applySchema(database);
      const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
      assert.deepEqual(foreignKeyFailures, []);
      const fakeBroadLocalShares = database.prepare(`
        SELECT COUNT(*) AS count
        FROM region_metric_observations
        WHERE metric_code = 'period_broad.local_within_province_share_pct'
      `).get().count;
      assert.equal(Number(fakeBroadLocalShares), 0, "광역자료의 원본 null을 0으로 만들면 안 됩니다.");
      const snapshotStatusCounts = Object.fromEntries(database.prepare(`
        SELECT validation_status, COUNT(*) AS count
        FROM company_snapshots
        GROUP BY validation_status
      `).all().map((row) => [row.validation_status, Number(row.count)]));
      assert.deepEqual(snapshotStatusCounts, { legacy_candidate: 10, review_required: 12 });

      upsertRegionMetric(database, {
        regionId: "kr_national",
        sourceId: "kto_visitor_api",
        metricCode: "test.accepted_value_guard",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        valueNum: 42,
        unit: "index",
        status: "complete",
        collectedAt: "2026-02-01T00:00:00.000Z",
        raw: { fixture: "complete" }
      });
      upsertRegionMetric(database, {
        regionId: "kr_national",
        sourceId: "kto_visitor_api",
        metricCode: "test.accepted_value_guard",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        valueNum: null,
        unit: "index",
        status: "error",
        collectedAt: "2026-02-02T00:00:00.000Z",
        raw: { fixture: "later_error" }
      });
      const protectedValue = database.prepare(`
        SELECT value_num, status
        FROM region_metric_current_values
        WHERE region_id = 'kr_national'
          AND source_id = 'kto_visitor_api'
          AND metric_code = 'test.accepted_value_guard'
      `).get();
      assert.equal(protectedValue.value_num, 42);
      assert.equal(protectedValue.status, "complete");
      const guardRevisionCount = database.prepare(`
        SELECT COUNT(*) AS count
        FROM region_metric_observations
        WHERE region_id = 'kr_national'
          AND source_id = 'kto_visitor_api'
          AND metric_code = 'test.accepted_value_guard'
      `).get().count;
      assert.equal(Number(guardRevisionCount), 2, "정상값과 이후 오류 관측을 모두 감사 이력으로 보존해야 합니다.");

      assert.throws(() => storeCompanyExternalIdentity(database, {
        companyId: "cmp_place_1705930719",
        providerCode: "naver_place",
        externalId: "1995649140",
        verifiedAt: "2026-08-29T00:00:00.000Z"
      }), (error) => error.code === "strong_company_identity_conflict");
      const originalIdentityOwner = database.prepare(`
        SELECT company_id
        FROM company_external_ids
        WHERE provider_code = 'naver_place' AND external_id = '1995649140'
      `).get().company_id;
      assert.equal(originalIdentityOwner, "cmp_place_1995649140");

      const sensitiveSourceCount = database.prepare(`
        SELECT COUNT(*) AS count
        FROM data_sources
        WHERE source_id LIKE '%password%'
           OR source_id LIKE '%credential%'
           OR source_id LIKE '%api_key%'
      `).get().count;
      assert.equal(Number(sensitiveSourceCount), 0);
      const orphanDatalabMetrics = database.prepare(`
        SELECT COUNT(*) AS count
        FROM keyword_metric_observations
        WHERE source_id = 'naver_datalab' AND run_id IS NULL
      `).get().count;
      assert.equal(Number(orphanDatalabMetrics), 0, "검색트렌드 관측은 수집회차와 연결되어야 합니다.");

      for (const table of [
        "collection_tasks",
        "collection_attempts",
        "company_channel_settings",
        "company_product_observations",
        "derived_metric_observations"
      ]) {
        const exists = database.prepare(`
          SELECT 1 AS present
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
        `).get(table);
        assert.equal(exists?.present, 1, `${table} 테이블이 준비되어야 합니다.`);
      }

      const countsWithFixture = databaseCounts(database);
      assert.equal(countsWithFixture.region_metric_observations, firstCounts.region_metric_observations + 2);
      assert.equal(countsWithFixture.region_metric_current, firstCounts.region_metric_current + 1);

      const emptyComplete = upsertRegionMetric(database, {
        regionId: "kr_national",
        sourceId: "kto_visitor_api",
        metricCode: "test.empty_complete_guard",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        valueNum: null,
        valueText: null,
        unit: "index",
        status: "complete",
        collectedAt: "2026-02-03T00:00:00.000Z",
        raw: { fixture: "empty_complete" }
      });
      const guardedEmpty = database.prepare(`
        SELECT status, value_num, value_text
        FROM region_metric_observations
        WHERE observation_id = ?
      `).get(emptyComplete.observationId);
      assert.equal(guardedEmpty.status, "no_data");
      assert.equal(guardedEmpty.value_num, null);
      assert.equal(guardedEmpty.value_text, null);

      upsertRegionMetric(database, {
        regionId: "kr_national",
        sourceId: "kto_visitor_api",
        metricCode: "test.partial_value_guard",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        valueNum: 7,
        unit: "index",
        status: "partial",
        collectedAt: "2026-02-03T00:00:00.000Z"
      });
      upsertRegionMetric(database, {
        regionId: "kr_national",
        sourceId: "kto_visitor_api",
        metricCode: "test.partial_value_guard",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        valueNum: null,
        unit: "index",
        status: "partial",
        collectedAt: "2026-02-04T00:00:00.000Z"
      });
      const protectedPartialValue = database.prepare(`
        SELECT value_num, status
        FROM region_metric_current_values
        WHERE metric_code = 'test.partial_value_guard'
      `).get();
      assert.equal(protectedPartialValue.value_num, 7);
      assert.equal(protectedPartialValue.status, "partial");

      const changedSchemaFile = path.join(temporaryDirectory, "changed_schema.sql");
      fs.writeFileSync(changedSchemaFile, `${fs.readFileSync(path.join(ROOT, "schemas", "master_db_v1.sql"), "utf8")}\n-- checksum drift fixture\n`, "utf8");
      assert.throws(
        () => applySchema(database, { schemaFile: changedSchemaFile }),
        (error) => error.code === "master_db_schema_checksum_mismatch"
      );
    } finally {
      database.close();
    }

    const fixtureDataDirectory = path.join(temporaryDirectory, "fixture_data");
    const fixtureCacheDirectory = path.join(fixtureDataDirectory, "tourism_data", "cache");
    const fixtureHistoryDirectory = path.join(fixtureDataDirectory, "history");
    const fixtureDatabasePath = path.join(temporaryDirectory, "fixture_master.sqlite");
    const fixturePath = path.join(fixtureCacheDirectory, "demand_strength_sancheong_202608.json");
    const invalidFixturePath = path.join(fixtureCacheDirectory, "visitor_invalid.json");
    const invalidMonthFixturePath = path.join(fixtureCacheDirectory, "visitor_invalid_month.json");
    const datalabFixturePath = path.join(fixtureHistoryDirectory, "datalab_trends.json");
    fs.mkdirSync(fixtureCacheDirectory, { recursive: true });
    fs.mkdirSync(fixtureHistoryDirectory, { recursive: true });
    const fixtureDocument = {
      schemaVersion: "test-v1",
      adapter: "tourism-demand-strength-test",
      status: "complete",
      yearMonth: "202608",
      region: { regionKey: "kr_gyeongnam_sancheong" },
      operations: {
        stay: {
          status: "complete",
          metrics: [{ code: "stay_intensity", value: 1 }]
        }
      }
    };
    const firstFixtureText = `${JSON.stringify(fixtureDocument, null, 2)}\n`;
    fs.writeFileSync(fixturePath, firstFixtureText, "utf8");
    fs.writeFileSync(invalidFixturePath, "{\n", "utf8");
    fs.writeFileSync(invalidMonthFixturePath, `${JSON.stringify({
      adapter: "tourism-visitor-test",
      status: "complete",
      yearMonth: "202613",
      allRegions: []
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(datalabFixturePath, `${JSON.stringify({
      keywords: {
        sancheong_trip: {
          keyword: "산청여행",
          observations: [{
            collectable: true,
            status: 200,
            debug: "https://example.test/?serviceKey=very-secret",
            series: [{ period: "202608", ratio: 50 }]
          }]
        }
      }
    }, null, 2)}\n`, "utf8");
    const fixedFixtureTime = new Date("2026-08-29T01:02:03.000Z");
    fs.utimesSync(fixturePath, fixedFixtureTime, fixedFixtureTime);
    fs.utimesSync(invalidFixturePath, fixedFixtureTime, fixedFixtureTime);
    fs.utimesSync(invalidMonthFixturePath, fixedFixtureTime, fixedFixtureTime);
    fs.utimesSync(datalabFixturePath, fixedFixtureTime, fixedFixtureTime);
    const fixturePreflight = inspectInputs(fixtureDataDirectory);
    assert.equal(fixturePreflight.parseErrors.length, 2, "잘못된 JSON과 13월 자료를 사전검사에서 찾아야 합니다.");

    const fixtureFirst = applyImport({ dataDir: fixtureDataDirectory, databasePath: fixtureDatabasePath });
    const fixtureSecond = applyImport({ dataDir: fixtureDataDirectory, databasePath: fixtureDatabasePath });
    assert.deepEqual(fixtureSecond.counts, fixtureFirst.counts, "수집시각 없는 cache도 재반입 시 중복되면 안 됩니다.");
    const fixtureDatabase = openMasterDatabase(fixtureDatabasePath);
    try {
      const rejectedParse = fixtureDatabase.prepare(`
        SELECT import_status, reason
        FROM legacy_import_ledger
        WHERE legacy_record_key = 'file:parse'
      `).get();
      assert.equal(rejectedParse.import_status, "rejected");
      assert.match(rejectedParse.reason, /^invalid_json:/);
      const rejectedPeriod = fixtureDatabase.prepare(`
        SELECT import_status, reason
        FROM legacy_import_ledger
        WHERE legacy_record_key = 'file:period'
      `).get();
      assert.equal(rejectedPeriod.import_status, "rejected");
      assert.equal(rejectedPeriod.reason, "invalid_year_month");
      const linkedDatalabMetric = fixtureDatabase.prepare(`
        SELECT observation.run_id
        FROM keyword_metric_observations observation
        JOIN collection_runs run ON run.run_id = observation.run_id
        WHERE observation.source_id = 'naver_datalab'
      `).get();
      assert.ok(linkedDatalabMetric?.run_id, "검색트렌드 관측은 수집회차와 연결되어야 합니다.");
      const leakedFixtureSecret = fixtureDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM keyword_metric_observations
        WHERE raw_json LIKE '%very-secret%'
      `).get().count;
      assert.equal(Number(leakedFixtureSecret), 0, "자유문구 URL의 서비스키가 raw_json에 남으면 안 됩니다.");
    } finally {
      fixtureDatabase.close();
    }

    const originalStats = fs.statSync(fixturePath);
    const changedFixtureText = firstFixtureText.replace('"value": 1', '"value": 2');
    assert.equal(Buffer.byteLength(changedFixtureText), Buffer.byteLength(firstFixtureText));
    fs.writeFileSync(fixturePath, changedFixtureText, "utf8");
    fs.utimesSync(fixturePath, originalStats.atime, originalStats.mtime);
    const fixtureThird = applyImport({ dataDir: fixtureDataDirectory, databasePath: fixtureDatabasePath });
    assert.equal(fixtureThird.counts.source_artifacts, fixtureSecond.counts.source_artifacts + 1);
    assert.equal(fixtureThird.counts.region_metric_observations, fixtureSecond.counts.region_metric_observations + 1);
    const changedFixtureSha = sha256File(fixturePath);
    const changedArtifactDatabase = openMasterDatabase(fixtureDatabasePath);
    try {
      const currentHashRecorded = changedArtifactDatabase.prepare(`
        SELECT 1 AS present
        FROM source_artifacts
        WHERE relative_path = 'tourism_data/cache/demand_strength_sancheong_202608.json'
          AND sha256 = ?
      `).get(changedFixtureSha);
      assert.equal(currentHashRecorded?.present, 1, "크기·mtime이 같아도 실제 내용 hash를 다시 확인해야 합니다.");
    } finally {
      changedArtifactDatabase.close();
    }

    assert.deepEqual(fileHashes(protectedFiles), beforeHashes, "Shadow 반입이 기존 원본 파일을 변경했습니다.");
    console.log("master DB tests passed");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

run();
