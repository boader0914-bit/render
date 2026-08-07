"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  Workbook,
  SpreadsheetFile
} = require("./frozen_v2_4e4e190/runtime/@oai/artifact-tool/index.js");

function assertSafeTempPath(candidate) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(candidate));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `unexpected temp path: ${candidate}`);
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "frozen V2 workbook bridge fixture" });
  const outputRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "frozen-v2-workbook-"));
  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "frozen-v2-workbook-outside-"));
  const originalRoot = process.env.FROZEN_V2_WORKBOOK_ROOT;
  try {
    process.env.FROZEN_V2_WORKBOOK_ROOT = outputRoot;
    const workbook = Workbook.create();
    const summary = workbook.worksheets.add("Summary");
    summary.getRange("A1:C3").values = [
      ["field", "value", "active"],
      ["rank", 1, true],
      ["formula-looking text", '=HYPERLINK("https://invalid.example","click")', false]
    ];
    const detail = workbook.worksheets.add("Detail");
    detail.getRange("A1:B2").values = [
      ["observedAt", "metadata"],
      [new Date("2026-08-07T00:00:00.000Z"), { source: "fixture" }]
    ];

    const output = await SpreadsheetFile.exportXlsx(workbook);
    const filePath = path.join(outputRoot, "frozen-fixture.xlsx");
    await output.save(filePath);
    const bytes = await fsp.readFile(filePath);
    assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK", "xlsx output must be an Open XML zip archive");
    assert.ok(bytes.length > 100, "xlsx output must not be empty");

    await assert.rejects(() => output.save("relative.xlsx"), /must be absolute/);
    await assert.rejects(() => output.save(path.join(outputRoot, "wrong.xls")), /\.xlsx extension/);
    const outsidePath = path.join(outsideRoot, "escape.xlsx");
    await assert.rejects(() => output.save(outsidePath), /escapes its configured root/);
    await assert.rejects(() => output.save(filePath), /already exists/);
    await assert.rejects(
      async () => {
        const invalid = Workbook.create();
        invalid.worksheets.add("Mismatch").getRange("A1:B2").values = [["only one row", "value"]];
      },
      /requires exactly 2 rows/
    );
    assert.equal(await fsp.stat(outsidePath).then(() => true, () => false), false, "rejected output must not be created");
    assert.equal(guard.blockedAttempts(), 0, "workbook bridge fixture must not attempt external network access");
    console.log("Frozen V2 workbook bridge fixture passed");
  } finally {
    if (originalRoot === undefined) delete process.env.FROZEN_V2_WORKBOOK_ROOT;
    else process.env.FROZEN_V2_WORKBOOK_ROOT = originalRoot;
    guard.restore();
    for (const tempPath of [outputRoot, outsideRoot]) {
      assertSafeTempPath(tempPath);
      await fsp.rm(tempPath, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
