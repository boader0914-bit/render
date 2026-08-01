const fsp = require("node:fs/promises");
const path = require("node:path");
const writeExcelFile = require("write-excel-file/node");

const WORKBOOK_LIMITS = Object.freeze({
  maxSheets: 32,
  maxRowsPerSheet: 200000,
  maxColumnsPerSheet: 512,
  maxTotalCells: 2000000,
  maxCellTextLength: 32000
});

function safeSheetName(name) {
  return String(name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
}

function stringifyCellObject(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateCellText(value, maxLength = WORKBOOK_LIMITS.maxCellTextLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const suffix = `...(truncated ${text.length} chars)`;
  return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function safeCellValue(value, maxLength = WORKBOOK_LIMITS.maxCellTextLength) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncateCellText(value, maxLength);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  // Dates are serialized as locale-independent text. This avoids spreadsheet
  // date-system/timezone shifts and does not require an implicit number format.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return truncateCellText(stringifyCellObject(value), maxLength);
  return truncateCellText(value, maxLength);
}

function explicitCell(value, maxLength) {
  const safe = safeCellValue(value, maxLength);
  if (typeof safe === "string") return { value: safe, type: String };
  if (typeof safe === "number") return { value: safe, type: Number };
  if (typeof safe === "boolean") return { value: safe, type: Boolean };
  return { value: String(safe ?? ""), type: String };
}

function workbookLimits(overrides = {}) {
  return {
    ...WORKBOOK_LIMITS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => Number.isInteger(value) && value > 0)
    )
  };
}

function validateWorkbookSheets(sheets, options = {}) {
  const limits = workbookLimits(options.limits);
  if (!Array.isArray(sheets) || !sheets.length) throw new TypeError("workbook requires at least one sheet");
  if (sheets.length > limits.maxSheets) throw new RangeError(`workbook exceeds ${limits.maxSheets} sheets`);

  const names = new Set();
  let totalCells = 0;
  const normalized = sheets.map((sheet, index) => {
    const name = safeSheetName(sheet?.name || `Sheet ${index + 1}`);
    if (names.has(name)) throw new Error(`duplicate workbook sheet name: ${name}`);
    names.add(name);
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    const columns = Array.isArray(sheet?.columns) ? sheet.columns.map(String) : [];
    if (!columns.length) throw new TypeError(`sheet ${name} requires at least one column`);
    if (columns.length > limits.maxColumnsPerSheet) {
      throw new RangeError(`sheet ${name} exceeds ${limits.maxColumnsPerSheet} columns`);
    }
    if (rows.length + 1 > limits.maxRowsPerSheet) {
      throw new RangeError(`sheet ${name} exceeds ${limits.maxRowsPerSheet} rows including its header`);
    }
    totalCells += (rows.length + 1) * columns.length;
    if (totalCells > limits.maxTotalCells) {
      throw new RangeError(`workbook exceeds ${limits.maxTotalCells} cells`);
    }
    return { name, rows, columns };
  });
  return { limits, sheets: normalized, totalCells };
}

function aoaFromRows(rows, columns, limits = WORKBOOK_LIMITS) {
  const header = columns.map((column) => explicitCell(column, limits.maxCellTextLength));
  return [
    header,
    ...rows.map((row) => columns.map((column) => explicitCell(row?.[column] ?? "", limits.maxCellTextLength)))
  ];
}

async function buildWorkbook(filePath, sheets, options = {}) {
  if (!filePath || !path.isAbsolute(filePath)) throw new TypeError("workbook output path must be absolute");
  if (path.extname(filePath).toLowerCase() !== ".xlsx") throw new TypeError("workbook output must use the .xlsx extension");
  const validated = validateWorkbookSheets(sheets, options);
  const workbook = validated.sheets.map((sheet) => ({
    sheet: sheet.name,
    data: aoaFromRows(sheet.rows, sheet.columns, validated.limits)
  }));
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await writeExcelFile(workbook).toFile(filePath);
  return {
    filePath,
    sheetNames: validated.sheets.map((sheet) => sheet.name),
    totalCells: validated.totalCells
  };
}

module.exports = {
  WORKBOOK_LIMITS,
  aoaFromRows,
  buildWorkbook,
  safeCellValue,
  safeSheetName,
  validateWorkbookSheets
};
