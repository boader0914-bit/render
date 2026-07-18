const path = require("node:path");
const writeXlsxFile = require("write-excel-file/node");

const EXPORT_LIMITS = Object.freeze({
  maxSheets: 20,
  maxRowsPerSheet: 100000,
  maxColumnsPerSheet: 256,
  maxCellCharacters: 32767
});

function spreadsheetExportError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function safeSheetName(name) {
  return String(name || "Sheet")
    .replace(/[\\/?*[\]:]/g, " ")
    .trim()
    .slice(0, 31) || "Sheet";
}

function safeSpreadsheetValue(value) {
  if (value === null || value === undefined) return { value: "", type: String };
  if (typeof value === "number" && Number.isFinite(value)) return { value, type: Number };
  if (typeof value === "boolean") return { value, type: Boolean };
  if (value instanceof Date && Number.isFinite(value.getTime())) return { value, type: Date };

  let text;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }

  text = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .slice(0, EXPORT_LIMITS.maxCellCharacters);

  // Explicit String typing prevents scraped values beginning with =, +, - or @ from becoming formulas.
  return { value: text, type: String };
}

function normalizeSheet(sheet, index) {
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
  if (!columns.length) throw spreadsheetExportError("XLSX_EMPTY_COLUMNS", `Sheet ${index + 1} has no columns.`);
  if (columns.length > EXPORT_LIMITS.maxColumnsPerSheet) {
    throw spreadsheetExportError("XLSX_COLUMN_LIMIT", `Sheet ${index + 1} exceeds the column limit.`);
  }
  if (rows.length > EXPORT_LIMITS.maxRowsPerSheet) {
    throw spreadsheetExportError("XLSX_ROW_LIMIT", `Sheet ${index + 1} exceeds the row limit.`);
  }

  const header = columns.map((column) => ({
    ...safeSpreadsheetValue(column),
    fontWeight: "bold",
    backgroundColor: "#E8EEF7"
  }));
  const data = rows.map((row) => columns.map((column) => safeSpreadsheetValue(row?.[column])));
  return {
    name: safeSheetName(sheet?.name || `Sheet ${index + 1}`),
    data: [header, ...data]
  };
}

async function buildWorkbook(filePath, sheets) {
  if (path.extname(String(filePath || "")).toLowerCase() !== ".xlsx") {
    throw spreadsheetExportError("XLSX_EXTENSION_REQUIRED", "Workbook output must use the .xlsx extension.");
  }
  if (!Array.isArray(sheets) || !sheets.length) {
    throw spreadsheetExportError("XLSX_EMPTY_WORKBOOK", "Workbook requires at least one sheet.");
  }
  if (sheets.length > EXPORT_LIMITS.maxSheets) {
    throw spreadsheetExportError("XLSX_SHEET_LIMIT", "Workbook exceeds the sheet limit.");
  }

  const normalized = sheets.map(normalizeSheet);
  const seenNames = new Map();
  const names = normalized.map((sheet) => {
    const base = sheet.name;
    const count = seenNames.get(base.toLowerCase()) || 0;
    seenNames.set(base.toLowerCase(), count + 1);
    if (!count) return base;
    const suffix = ` (${count + 1})`;
    return `${base.slice(0, 31 - suffix.length)}${suffix}`;
  });

  await writeXlsxFile(normalized.map((sheet, index) => ({
    data: sheet.data,
    sheet: names[index]
  }))).toFile(filePath);
}

module.exports = {
  EXPORT_LIMITS,
  buildWorkbook,
  safeSheetName,
  safeSpreadsheetValue
};
