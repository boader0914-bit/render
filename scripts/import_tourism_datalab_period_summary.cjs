#!/usr/bin/env node

const path = require("node:path");
const {
  ADAPTER_VERSION,
  createPeriodSummaryImporter
} = require("./tourism_datalab_period_summary.cjs");

const ROOT = path.resolve(__dirname, "..");

function usage() {
  return [
    "한국관광 데이터랩 공식 다운로드 ZIP을 별도 기간요약 Snapshot으로 검증·반입합니다.",
    "",
    "사용법:",
    "  node scripts/import_tourism_datalab_period_summary.cjs --file <zip> [--apply]",
    "    [--tourism-data-dir <directory>] [--region-master <json>]",
    "",
    "기본 동작은 dry-run입니다. --apply를 명시해야 period_summaries에 저장합니다.",
    "기존 cache/visitors 및 demand-strength 파일은 읽거나 수정하지 않습니다."
  ].join("\n");
}

function parseArguments(argv) {
  const parsed = {
    apply: false,
    filePath: "",
    tourismDataDir: "",
    regionMasterFile: "",
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      parsed.apply = true;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (["--file", "--tourism-data-dir", "--region-master"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--file") parsed.filePath = value;
      if (argument === "--tourism-data-dir") parsed.tourismDataDir = value;
      if (argument === "--region-master") parsed.regionMasterFile = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!parsed.help && !parsed.filePath) throw new Error("--file is required.");
  return parsed;
}

function defaultTourismDataDir() {
  if (process.env.TOURISM_DATA_DIR) return process.env.TOURISM_DATA_DIR;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, "tourism_data");
  return path.join(ROOT, "tourism_data");
}

function resultSummary(result) {
  const snapshot = result.snapshot;
  return {
    ok: result.ok,
    status: result.status,
    reason: result.reason,
    dryRun: result.status === "dry_run",
    applied: result.applied,
    adapter: ADAPTER_VERSION,
    period: snapshot.period,
    targetFilePath: result.targetFilePath,
    writtenFilePath: result.filePath,
    archiveFileName: snapshot.source.archiveFileName,
    archiveSha256: snapshot.source.archiveSha256,
    quality: {
      status: snapshot.quality.status,
      broadRegionCount: snapshot.quality.broadRegionCount,
      localRegionCount: snapshot.quality.localRegionCount,
      trendMonthCount: snapshot.quality.trendMonthCount,
      mappingCounts: snapshot.quality.mappingCounts
    },
    policy: snapshot.policy
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const importer = createPeriodSummaryImporter({
    tourismDataDir: path.resolve(args.tourismDataDir || defaultTourismDataDir()),
    ...(args.regionMasterFile ? { regionMasterFile: path.resolve(args.regionMasterFile) } : {})
  });
  const result = await importer.importArchive({
    filePath: path.resolve(args.filePath),
    apply: args.apply
  });
  process.stdout.write(`${JSON.stringify(resultSummary(result), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      status: "error",
      code: error.code || "invalid_arguments",
      message: error.message || String(error)
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  resultSummary,
  main
};
