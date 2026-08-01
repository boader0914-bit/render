const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const spreadsheetPackageDir = path.dirname(require.resolve("write-excel-file/package.json"));
const { unzipSync, strFromU8 } = require(require.resolve("fflate", { paths: [spreadsheetPackageDir] }));
const {
  WORKBOOK_LIMITS,
  buildWorkbook,
  safeCellValue,
  safeSheetName,
  validateWorkbookSheets
} = require("./workbook_export.cjs");

function workbookXmlEntries(buffer) {
  return Object.fromEntries(
    Object.entries(unzipSync(buffer))
      .filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"))
      .map(([name, value]) => [name, strFromU8(value)])
  );
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "workbook-export-"));
  try {
    const crawlerSource = await fsp.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
    assert.match(crawlerSource, /workbook:\s*`\$\{prefix\}_전체수집결과\.xlsx`/);
    assert.match(crawlerSource, /naverWorkbook:\s*`\$\{prefix\}_네이버순위통합\.xlsx`/);
    assert.match(crawlerSource, /name:\s*"요약"[\s\S]*?columns:\s*\["항목",\s*"값"\]/);
    for (const sheetName of ["플랫폼테스트", "네이버전체순위", "네이버광고순위", "네이버지역별상위5", "떠나요"]) {
      assert.match(crawlerSource, new RegExp(`name:\\s*"${sheetName}"`), `crawler workbook must preserve the ${sheetName} sheet`);
    }
    assert.equal(safeSheetName("bad/name:*?[]"), "bad name     ");
    assert.equal(safeCellValue(Number.POSITIVE_INFINITY), "Infinity");
    assert.equal(safeCellValue({ existing: "field" }), '{"existing":"field"}');
    assert.equal(safeCellValue(new Date("2026-08-01T00:00:00.000Z")), "2026-08-01T00:00:00.000Z");
    assert.equal(safeCellValue(new Date("invalid")), "");
    const longText = "가".repeat(WORKBOOK_LIMITS.maxCellTextLength + 100);
    const truncated = safeCellValue(longText);
    assert.equal(truncated.length, WORKBOOK_LIMITS.maxCellTextLength);
    assert.match(truncated, /truncated 32100 chars/);

    assert.throws(
      () => validateWorkbookSheets([
        { name: "same", rows: [], columns: ["a"] },
        { name: "same", rows: [], columns: ["b"] }
      ]),
      /duplicate workbook sheet name/
    );
    assert.throws(
      () => validateWorkbookSheets([{ name: "one", rows: [{ a: "value" }], columns: ["a"] }], { limits: { maxTotalCells: 1, maxRowsPerSheet: 2 } }),
      /exceeds 1 cells/
    );
    assert.throws(
      () => validateWorkbookSheets([
        { name: "one", rows: [], columns: ["a"] },
        { name: "two", rows: [], columns: ["b"] }
      ], { limits: { maxSheets: 1 } }),
      /exceeds 1 sheets/
    );

    const filePath = path.join(tempRoot, "가평_전체수집결과.xlsx");
    const result = await buildWorkbook(filePath, [
      {
        name: "요약",
        columns: ["항목", "값"],
        rows: [
          { 항목: "검색어", 값: "가평펜션" },
          { 항목: "실제 0", 값: 0 },
          { 항목: "불리언", 값: false },
          { 항목: "기준시각", 값: new Date("2026-08-01T00:00:00.000Z") }
        ]
      },
      {
        name: "플랫폼테스트",
        columns: ["업체명", "위험문자열", "메타"],
        rows: [
          {
            업체명: "긴 업체명도 보존되는 테스트 펜션",
            위험문자열: '=HYPERLINK("https://invalid.example","click")',
            메타: { unknownFutureField: "preserved-as-text" }
          }
        ]
      }
    ]);
    assert.equal(path.basename(result.filePath), "가평_전체수집결과.xlsx", "caller-provided workbook filename must be preserved");
    assert.deepEqual(result.sheetNames, ["요약", "플랫폼테스트"]);
    assert.equal(result.totalCells, 16);

    const buffer = await fsp.readFile(filePath);
    assert.equal(buffer.subarray(0, 2).toString("ascii"), "PK", "xlsx output must be an Open XML zip archive");
    const entries = workbookXmlEntries(buffer);
    assert.ok(entries["xl/workbook.xml"], "workbook metadata must exist");
    assert.match(entries["xl/workbook.xml"], /name="요약"/);
    assert.match(entries["xl/workbook.xml"], /name="플랫폼테스트"/);
    assert.equal(Object.keys(entries).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 2);
    assert.match(entries["xl/worksheets/sheet1.xml"], /<c r="A2" t="s">/, "text columns must remain string cells");
    assert.match(entries["xl/worksheets/sheet1.xml"], /<c r="B3"><v>0<\/v><\/c>/, "numeric zero must remain a numeric zero");
    assert.match(entries["xl/worksheets/sheet1.xml"], /<c r="B4" t="b"><v>0<\/v><\/c>/, "boolean false must remain a boolean false");
    const allXml = Object.values(entries).join("\n");
    assert.match(allXml, /가평펜션/);
    assert.match(allXml, /긴 업체명도 보존되는 테스트 펜션/);
    assert.match(allXml, /HYPERLINK/);
    assert.match(allXml, /2026-08-01T00:00:00\.000Z/, "dates must be exported as timezone-stable ISO text");
    assert.doesNotMatch(allXml, /<f(?:\s|>)/, "formula-looking provider text must be emitted as a string, not a formula");
    assert.equal(Object.keys(unzipSync(buffer)).some((name) => /vbaProject\.bin$/i.test(name)), false, "xlsx output must not contain macros");

    await assert.rejects(
      () => buildWorkbook(path.join(tempRoot, "bad.xls"), [{ name: "one", rows: [], columns: ["a"] }]),
      /\.xlsx extension/
    );
    await assert.rejects(
      () => buildWorkbook("relative.xlsx", [{ name: "one", rows: [], columns: ["a"] }]),
      /absolute/
    );

    console.log("Safe XLSX workbook export checks passed");
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected temp path: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
