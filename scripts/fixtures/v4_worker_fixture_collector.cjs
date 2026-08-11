const fsp = require("node:fs/promises");
const path = require("node:path");

const scenario = process.env.V4_WORKER_FIXTURE_SCENARIO || "success";
const keyword = process.argv[2] || "fixture keyword";
const outputRoot = path.resolve(process.env.OUTPUTS_DIR || "outputs");
const outputDir = path.join(outputRoot, `fixture_glamping_${process.env.RUN_STAMP || "run"}`);

async function write(file, value) {
  const target = path.join(outputDir, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, value);
}

async function main() {
  if (scenario === "slow") await new Promise((resolve) => setTimeout(resolve, 700));
  if (scenario === "exit") {
    process.stderr.write(`fixture exit; inherited secret=${process.env.V4_WORKER_PRIVATE_SECRET || "not-inherited"}\n`);
    process.exitCode = 7;
    return;
  }

  await fsp.mkdir(outputDir, { recursive: true });
  if (scenario === "partial") {
    await write("partial.csv", "partial\n");
    process.stderr.write(`fixture partial failure; inherited secret=${process.env.V4_WORKER_PRIVATE_SECRET || "not-inherited"}\n`);
    process.exitCode = 9;
    return;
  }

  const fileRoles = {
    platform: "platform.csv",
    report: "report.md",
    overall: "naver_overall.csv",
    ads: "naver_ads.csv",
    regional: "naver_regional.csv",
    ddnayo: "ddnayo.csv",
    workbook: "all_results.xlsx",
    naverWorkbook: "naver_results.xlsx"
  };
  for (const file of Object.values(fileRoles)) {
    await write(file, file.endsWith(".xlsx") ? Buffer.from("fixture-xlsx") : `fixture,${file}\n`);
  }
  await write("details/place_room_fixture.json", `${JSON.stringify({ ok: true })}\n`);

  const manifest = {
    outputDir: scenario === "manifest-outside" ? path.resolve(outputRoot, "..", "outside") : outputDir,
    keyword,
    keywordType: "province",
    searchMode: process.env.SEARCH_MODE,
    searchModeLabel: "Keyword",
    collectionMode: process.env.COLLECTION_MODE,
    collectionModeLabel: "Precision",
    collectionPurpose: process.env.COLLECTION_PURPOSE,
    collectionPurposeLabel: "Revenue detail",
    collectionProfile: "revenue_detail_deep",
    collectionProfileLabel: "Revenue detail",
    collectionProfileNote: "Offline fixture",
    collectionProfileFlags: {
      collectRegional: true,
      collectOta: true,
      collectBookingStock: true,
      collectWeeklyRange: true
    },
    sourceRole: process.env.SOURCE_ROLE,
    collectionSource: process.env.COLLECTION_SOURCE,
    collectionSourceLabel: process.env.COLLECTION_SOURCE_LABEL,
    detailRankRanges: process.env.DETAIL_RANK_RANGES,
    provinceKey: "fixture",
    regionSlug: "fixture",
    searchKeyword: keyword,
    naverKeyword: keyword,
    naverAttemptedQueries: [{ query: keyword, matched: 1 }],
    checkIn: process.env.CHECK_IN,
    checkOut: process.env.CHECK_OUT,
    adults: Number(process.env.ADULTS),
    productMode: process.env.PRODUCT_MODE,
    productModeLabel: "All",
    bookingRangeDays: Number(process.env.BOOKING_RANGE_DAYS),
    bookingRangePlaceLimit: Number(process.env.BOOKING_RANGE_PLACE_LIMIT),
    bookingRangeCollectionText: "Offline fixture",
    fileRoles,
    files: Object.values(fileRoles),
    detailJsonFiles: ["details/place_room_fixture.json"],
    counts: {
      naverOverall: 1,
      naverAds: 0,
      naverRegional: 1,
      naverBookingStockChecked: 1,
      naverBookingStockSucceeded: 1,
      naverBookingStockSkippedByMode: 0,
      naverBookingStockSkippedByRank: 0,
      nolFirstPage: 1,
      nolRawFirstPage: 1,
      nolFilteredOut: 0,
      ddnayo: 1,
      detailJsonFiles: 1
    }
  };
  if (scenario === "missing-file") manifest.files.push("missing.csv");
  await write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`offline fixture completed\n${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
