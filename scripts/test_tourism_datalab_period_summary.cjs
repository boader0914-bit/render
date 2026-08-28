const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  ADAPTER_VERSION,
  POLICY,
  createPeriodSummaryImporter,
  readSafeZipBuffer,
  crc32
} = require("./tourism_datalab_period_summary.cjs");

function shiftYearMonth(value, offset) {
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1 + offset, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function localNames(province, count) {
  const first = {
    테스트도: ["테스트군"],
    광주광역시: ["동구"],
    전라남도: ["목포시"],
    인천광역시: ["중구", "동구", "서구"],
    세종특별자치시: ["세종특별자치시"]
  }[province] || [];
  const result = [...first];
  while (result.length < count) result.push(`${province.replace(/[^가-힣0-9]/g, "")}가상군${String(result.length + 1).padStart(2, "0")}`);
  return result;
}

function buildOfficialCsvEntries({ timestamp, startYearMonth, testVisitorCount }) {
  const provinces = [
    "테스트도",
    "광주광역시",
    "전라남도",
    "인천광역시",
    "세종특별자치시",
    ...Array.from({ length: 11 }, (_, index) => `가상도${String(index + 1).padStart(2, "0")}`)
  ];
  const broadRows = [];
  const heatmapRows = [];
  const localRows = [];
  let localRowCount = 0;
  provinces.forEach((province, provinceIndex) => {
    const provinceVisitorCount = 1_000_000 + provinceIndex * 10_000;
    const provinceShare = 6.25;
    const count = provinceIndex < 12 ? 14 : 13;
    const names = localNames(province, count);
    const baseShare = Math.floor(1000 / count) / 10;
    let assignedShare = 0;
    names.forEach((localName, localIndex) => {
      const localShare = localIndex === names.length - 1
        ? Number((100 - assignedShare).toFixed(1))
        : baseShare;
      assignedShare = Number((assignedShare + localShare).toFixed(1));
      const visitorCount = province === "테스트도" && localName === "테스트군"
        ? testVisitorCount
        : 10_000 + provinceIndex * 100 + localIndex;
      localRows.push([
        province,
        localName,
        provinceVisitorCount,
        provinceShare,
        visitorCount,
        localShare
      ]);
      localRowCount += 1;
    });
    broadRows.push([province, provinceVisitorCount, provinceShare]);
    heatmapRows.push([province, provinceVisitorCount]);
  });
  assert.equal(provinces.length, 16);
  assert.equal(localRowCount, 220);

  const trendRows = [];
  for (let index = 0; index < 12; index += 1) {
    const yearMonth = shiftYearMonth(startYearMonth, index);
    const resident = 100_000 + index * 1_000;
    const nonResident = 200_000 + index * 2_000;
    trendRows.push([yearMonth, "전국", "현지인방문자(a)", resident]);
    trendRows.push([yearMonth, "전국", "외지인방문자(b)", nonResident]);
    trendRows.push([yearMonth, "전국", "전체방문자(a+b)", resident + nonResident]);
  }

  return [
    {
      name: `${timestamp}_방문자수 히트맵.csv`,
      data: Buffer.from(csv(["광역지자체", "방문자 수"], heatmapRows), "utf8"),
      method: 0
    },
    {
      name: `${timestamp}_지역별 방문자 수(기초지자체별).csv`,
      data: Buffer.from(csv([
        "광역지자체명",
        "기초지자체명",
        "광역지자체 방문자 수",
        "광역지자체 방문자 비율",
        "기초지자체 방문자 수",
        "기초지자체 방문자 비율"
      ], localRows), "utf8"),
      method: 8
    },
    {
      name: `${timestamp}_지역별 방문자 수(광역별).csv`,
      data: Buffer.from(csv(["광역지자체명", "광역지자체 방문자 수", "광역지자체 방문자 비율"], broadRows), "utf8"),
      method: 8
    },
    {
      name: `${timestamp}_방문자 수 추이.csv`,
      data: Buffer.from(csv(["기준년월", "광역지자체", "방문자 구분", "방문자 수"], trendRows), "utf8"),
      method: 8
    }
  ];
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const flags = entry.flags ?? 0x0800;
    const method = entry.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data) : Buffer.from(entry.data);
    const checksum = entry.crcOverride ?? crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function regionUnit({ regionKey, fullName, name, level = "local", active = true, sidoFull = "" }) {
  return {
    regionKey,
    fullName,
    name,
    level,
    sidoFull,
    sigungu: level === "local" ? name : "",
    officialCode: regionKey.replace(/\D/g, "").padEnd(10, "0").slice(0, 10) || "0000000000",
    active,
    status: active ? "active" : "retired",
    selectable: active
  };
}

function testRegionMaster() {
  return {
    version: "test-region-master-v1",
    units: [
      regionUnit({ regionKey: "kr_test_broad", fullName: "테스트도", name: "테스트도", level: "broad", sidoFull: "테스트도" }),
      regionUnit({ regionKey: "kr_test_local", fullName: "테스트도 테스트군", name: "테스트군", sidoFull: "테스트도" }),
      regionUnit({ regionKey: "kr_integrated_broad", fullName: "전남광주통합특별시", name: "전남광주통합특별시", level: "broad", sidoFull: "전남광주통합특별시" }),
      regionUnit({ regionKey: "kr_integrated_dong", fullName: "전남광주통합특별시 동구", name: "동구", sidoFull: "전남광주통합특별시" }),
      regionUnit({ regionKey: "kr_integrated_mokpo", fullName: "전남광주통합특별시 목포시", name: "목포시", sidoFull: "전남광주통합특별시" }),
      regionUnit({ regionKey: "kr_old_gwangju", fullName: "광주광역시", name: "광주광역시", level: "broad", active: false, sidoFull: "광주광역시" }),
      regionUnit({ regionKey: "kr_old_gwangju_dong", fullName: "광주광역시 동구", name: "동구", active: false, sidoFull: "광주광역시" }),
      regionUnit({ regionKey: "kr_old_jeonnam", fullName: "전라남도", name: "전라남도", level: "broad", active: false, sidoFull: "전라남도" }),
      regionUnit({ regionKey: "kr_old_jeonnam_mokpo", fullName: "전라남도 목포시", name: "목포시", active: false, sidoFull: "전라남도" }),
      regionUnit({ regionKey: "kr_old_incheon_jung", fullName: "인천광역시 중구", name: "중구", active: false, sidoFull: "인천광역시" }),
      regionUnit({ regionKey: "kr_old_incheon_dong", fullName: "인천광역시 동구", name: "동구", active: false, sidoFull: "인천광역시" }),
      regionUnit({ regionKey: "kr_old_incheon_seo", fullName: "인천광역시 서구", name: "서구", active: false, sidoFull: "인천광역시" }),
      regionUnit({ regionKey: "kr_new_incheon", fullName: "인천광역시 제물포구", name: "제물포구", sidoFull: "인천광역시" }),
      regionUnit({ regionKey: "kr_sejong", fullName: "세종특별자치시", name: "세종특별자치시", level: "broad", sidoFull: "세종특별자치시" })
    ]
  };
}

async function expectCode(action, code) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `Expected ${code} to be thrown.`);
  assert.equal(caught.code, code);
}

async function run() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-period-summary-"));
  assert.ok(path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir())));
  try {
    const tourismDataDir = path.join(temporaryRoot, "tourism_data");
    const cacheDir = path.join(tourismDataDir, "cache");
    const regionMasterFile = path.join(temporaryRoot, "region_master.json");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(regionMasterFile, JSON.stringify(testRegionMaster()), "utf8");
    const visitorSentinel = path.join(cacheDir, "visitors__sentinel.json");
    const demandSentinel = path.join(cacheDir, "demand-strength__sentinel.json");
    await fsp.writeFile(visitorSentinel, "visitor-cache-must-not-change", "utf8");
    await fsp.writeFile(demandSentinel, "demand-cache-must-not-change", "utf8");

    const latestTimestamp = "20260828120000";
    const latestZipPath = path.join(temporaryRoot, `${latestTimestamp}__202507-202606_데이터랩_다운로드.zip`);
    const latestEntries = buildOfficialCsvEntries({
      timestamp: latestTimestamp,
      startYearMonth: "202507",
      testVisitorCount: 125
    });
    const latestZip = buildZip(latestEntries);
    await fsp.writeFile(latestZipPath, latestZip);

    const decodedEntries = readSafeZipBuffer(latestZip);
    assert.equal(decodedEntries.length, 4);
    assert.deepEqual(decodedEntries.map((entry) => entry.compressionMethod).sort(), [0, 8, 8, 8]);
    await expectCode(() => Promise.resolve(readSafeZipBuffer(latestZip, { maxEntries: 3 })), "zip_entry_limit");
    await expectCode(() => Promise.resolve(readSafeZipBuffer(latestZip, { maxArchiveBytes: latestZip.length - 1 })), "archive_too_large");

    const traversalEntries = latestEntries.map((entry, index) => index ? entry : { ...entry, name: `../${entry.name}` });
    await expectCode(() => Promise.resolve(readSafeZipBuffer(buildZip(traversalEntries))), "unsafe_zip_path");
    const encryptedEntries = latestEntries.map((entry, index) => index ? entry : { ...entry, flags: 0x0801 });
    await expectCode(() => Promise.resolve(readSafeZipBuffer(buildZip(encryptedEntries))), "encrypted_zip");
    const unsupportedEntries = latestEntries.map((entry, index) => index ? entry : { ...entry, method: 12 });
    await expectCode(() => Promise.resolve(readSafeZipBuffer(buildZip(unsupportedEntries))), "unsupported_compression");
    const badCrcEntries = latestEntries.map((entry, index) => index ? entry : { ...entry, crcOverride: (crc32(entry.data) + 1) >>> 0 });
    await expectCode(() => Promise.resolve(readSafeZipBuffer(buildZip(badCrcEntries))), "crc_mismatch");

    const fixedNow = new Date("2026-08-28T03:30:00.000Z");
    const importer = createPeriodSummaryImporter({
      tourismDataDir,
      regionMasterFile,
      now: () => fixedNow
    });
    assert.equal(importer.summaryForRegion, importer.periodSummaryForRegion);

    const dryRun = await importer.importArchive({ filePath: latestZipPath });
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.snapshot.quality.status, "complete");
    assert.equal(dryRun.snapshot.quality.broadRegionCount, 16);
    assert.equal(dryRun.snapshot.quality.localRegionCount, 220);
    assert.deepEqual(dryRun.snapshot.policy, POLICY);
    assert.equal(await fsp.stat(path.dirname(dryRun.targetFilePath)).then(() => true, () => false), false);

    const successor = dryRun.snapshot.localRegions.find((row) => row.sourceProvinceName === "광주광역시" && row.sourceLocalName === "동구");
    assert.equal(successor.mappingStatus, "province-successor");
    assert.equal(successor.currentRegionKey, "kr_integrated_dong");
    const oldIncheon = dryRun.snapshot.localRegions.find((row) => row.sourceProvinceName === "인천광역시" && row.sourceLocalName === "중구");
    assert.equal(oldIncheon.mappingStatus, "unalignable");
    assert.equal(oldIncheon.currentRegionKey, null);
    assert.equal(oldIncheon.historicalRegionKey, "kr_old_incheon_jung");

    const appliedLatest = await importer.importArchive({ filePath: latestZipPath, apply: true });
    assert.equal(appliedLatest.status, "applied");
    assert.equal(appliedLatest.applied, true);
    assert.equal(
      path.basename(appliedLatest.filePath),
      `${ADAPTER_VERSION}__202507__202606.json`
    );
    const stored = JSON.parse(await fsp.readFile(appliedLatest.filePath, "utf8"));
    assert.equal(stored.source.archiveSha256, dryRun.snapshot.source.archiveSha256);
    const idempotent = await importer.importArchive({ filePath: latestZipPath, apply: true });
    assert.equal(idempotent.status, "unchanged");
    assert.equal(idempotent.applied, false);

    await fsp.writeFile(latestZipPath, buildZip(buildOfficialCsvEntries({
      timestamp: latestTimestamp,
      startYearMonth: "202507",
      testVisitorCount: 126
    })));
    await expectCode(() => importer.importArchive({ filePath: latestZipPath, apply: true }), "snapshot_conflict");
    await fsp.writeFile(latestZipPath, latestZip);

    const previousTimestamp = "20250828120000";
    const previousZipPath = path.join(temporaryRoot, `${previousTimestamp}__202407-202506_데이터랩_다운로드.zip`);
    await fsp.writeFile(previousZipPath, buildZip(buildOfficialCsvEntries({
      timestamp: previousTimestamp,
      startYearMonth: "202407",
      testVisitorCount: 100
    })));
    await importer.importArchive({ filePath: previousZipPath, apply: true });

    const regional = await importer.periodSummaryForRegion({ regionKey: "kr_test_local" });
    assert.equal(regional.ok, true);
    assert.equal(regional.status, "ok");
    assert.equal(regional.snapshots.length, 2);
    assert.deepEqual(regional.snapshots.map((row) => row.period.endYearMonth), ["202506", "202606"]);
    assert.equal(regional.previous.visitorCount, 100);
    assert.equal(regional.latest.visitorCount, 125);
    assert.deepEqual(regional.comparison, { status: "ready", changeRate: 0.25, changePercent: 25 });
    assert.deepEqual(regional.source, { label: "한국관광 데이터랩 공식 다운로드" });
    assert.deepEqual(regional.policy, POLICY);

    const forbiddenCurrent = await importer.periodSummaryForRegion("kr_new_incheon");
    assert.equal(forbiddenCurrent.ok, false);
    assert.equal(forbiddenCurrent.reason, "period_summary_not_found");
    const retainedHistorical = await importer.periodSummaryForRegion("kr_old_incheon_jung");
    assert.equal(retainedHistorical.ok, true);
    assert.equal(retainedHistorical.latest.mappingStatus, "unalignable");

    const sejongSource = appliedLatest.snapshot.localRegions.find((row) => (
      row.sourceProvinceName === "세종특별자치시"
      && row.sourceLocalName === "세종특별자치시"
    ));
    const sejong = await importer.periodSummaryForRegion("kr_sejong");
    assert.equal(sejong.ok, true);
    assert.equal(sejong.latest.visitorCount, sejongSource.visitorCount);
    assert.notEqual(
      sejong.latest.visitorCount,
      sejongSource.visitorCount + appliedLatest.snapshot.broadRegions.find((row) => row.sourceProvinceName === "세종특별자치시").visitorCount
    );

    const status = await importer.status();
    assert.equal(status.status, "ready");
    assert.equal(status.summaryCount, 2);
    assert.equal(status.snapshotCount, 2);
    assert.equal(status.latest.period.endYearMonth, "202606");
    assert.equal(status.invalidFileCount, 0);
    assert.equal(await fsp.readFile(visitorSentinel, "utf8"), "visitor-cache-must-not-change");
    assert.equal(await fsp.readFile(demandSentinel, "utf8"), "demand-cache-must-not-change");

    const overlapTimestamp = "20260828130000";
    const overlapZipPath = path.join(temporaryRoot, `${overlapTimestamp}__202501-202512_데이터랩_다운로드.zip`);
    await fsp.writeFile(overlapZipPath, buildZip(buildOfficialCsvEntries({
      timestamp: overlapTimestamp,
      startYearMonth: "202501",
      testVisitorCount: 115
    })));
    await importer.importArchive({ filePath: overlapZipPath, apply: true });
    const overlapComparison = await importer.periodSummaryForRegion("kr_test_local");
    assert.equal(overlapComparison.comparison.status, "overlapping_periods");
    assert.equal(overlapComparison.comparison.changeRate, null);

    const corruptDataDir = path.join(temporaryRoot, "corrupt_data");
    const corruptSummaryDir = path.join(corruptDataDir, "period_summaries");
    await fsp.mkdir(corruptSummaryDir, { recursive: true });
    const corrupted = JSON.parse(JSON.stringify(appliedLatest.snapshot));
    delete corrupted.localRegions[0].visitorCount;
    await fsp.writeFile(
      path.join(corruptSummaryDir, `${ADAPTER_VERSION}__202507__202606.json`),
      JSON.stringify(corrupted),
      "utf8"
    );
    const corruptImporter = createPeriodSummaryImporter({ tourismDataDir: corruptDataDir, regionMasterFile });
    await expectCode(
      () => corruptImporter.readSummary({ startYearMonth: "202507", endYearMonth: "202606" }),
      "invalid_snapshot"
    );
    const corruptStatus = await corruptImporter.status();
    assert.equal(corruptStatus.status, "degraded");
    assert.equal(corruptStatus.snapshotCount, 0);
    assert.equal(corruptStatus.invalidFileCount, 1);

    const officialZip = process.env.KTO_OFFICIAL_TEST_ZIP || path.join(
      os.homedir(),
      "Downloads",
      "20260828105015__202507-202606_데이터랩_다운로드.zip"
    );
    if (await fsp.stat(officialZip).then((stat) => stat.isFile(), () => false)) {
      const officialImporter = createPeriodSummaryImporter({
        tourismDataDir: path.join(temporaryRoot, "official_dry_run"),
        regionMasterFile: path.join(__dirname, "..", "web", "data", "region_master.json"),
        now: () => fixedNow
      });
      const official = await officialImporter.importArchive({ filePath: officialZip });
      assert.equal(official.status, "dry_run");
      assert.equal(official.snapshot.source.archiveSha256, "f4854314cf6173b8cd21ed869d38c33af4842cf380722b3a54881a742d33bece");
      assert.equal(official.snapshot.quality.broadRegionCount, 17);
      assert.equal(official.snapshot.quality.localRegionCount, 229);
      assert.equal(official.snapshot.quality.trendMonthCount, 12);
      assert.equal(official.snapshot.quality.unalignableMappingCount, 3);
    }

    const officialThree = [
      "C:\\Users\\User\\Downloads\\20260828112609__202307-202406_데이터랩_다운로드.zip",
      "C:\\Users\\User\\Downloads\\20260828112425__202407-202506_데이터랩_다운로드.zip",
      officialZip
    ];
    const officialThreeAvailable = (await Promise.all(officialThree.map((filePath) => (
      fsp.stat(filePath).then((stat) => stat.isFile(), () => false)
    )))).every(Boolean);
    if (officialThreeAvailable) {
      const actualRegionMasterFile = path.join(__dirname, "..", "web", "data", "region_master.json");
      const actualMaster = JSON.parse(await fsp.readFile(actualRegionMasterFile, "utf8"));
      const sancheongUnit = actualMaster.units.find((unit) => unit.active === true && unit.fullName === "경상남도 산청군");
      const sejongUnit = actualMaster.units.find((unit) => unit.active === true && unit.fullName === "세종특별자치시");
      assert.ok(sancheongUnit?.regionKey);
      assert.ok(sejongUnit?.regionKey);
      const officialThreeImporter = createPeriodSummaryImporter({
        tourismDataDir: path.join(temporaryRoot, "official_three_periods"),
        regionMasterFile: actualRegionMasterFile,
        now: () => fixedNow
      });
      for (const filePath of officialThree) {
        const applied = await officialThreeImporter.importArchive({ filePath, apply: true });
        assert.equal(applied.status, "applied");
      }
      const sancheong = await officialThreeImporter.periodSummaryForRegion(sancheongUnit.regionKey);
      assert.equal(sancheong.ok, true);
      assert.equal(sancheong.snapshots.length, 3);
      assert.equal(sancheong.comparison.status, "ready");
      const sejongActual = await officialThreeImporter.periodSummaryForRegion(sejongUnit.regionKey);
      assert.equal(sejongActual.ok, true);
      assert.equal(sejongActual.snapshots.length, 3);
      const latestOfficial = (await officialThreeImporter.latestSummary()).data;
      const sejongLocal = latestOfficial.localRegions.find((row) => (
        row.sourceProvinceName === "세종특별자치시"
        && row.sourceLocalName === "세종특별자치시"
      ));
      assert.equal(sejongActual.latest.visitorCount, sejongLocal.visitorCount);
    }

    process.stdout.write("tourism_datalab_period_summary tests passed\n");
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
