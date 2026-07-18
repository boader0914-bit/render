const path = require("node:path");
const { Worker } = require("node:worker_threads");

const IMPORT_LIMITS = Object.freeze({
  maxBytes: Number(process.env.IMPORT_MAX_BYTES || 1024 * 1024),
  maxRows: Number(process.env.IMPORT_MAX_ROWS || 5000),
  maxColumns: Number(process.env.IMPORT_MAX_COLUMNS || 64),
  maxCells: Number(process.env.IMPORT_MAX_CELLS || 150000),
  maxCellCharacters: Number(process.env.IMPORT_MAX_CELL_CHARACTERS || 16384),
  maxLineCharacters: Number(process.env.IMPORT_MAX_LINE_CHARACTERS || 65536),
  parseTimeoutMs: Number(process.env.IMPORT_PARSE_TIMEOUT_MS || 5000)
});

const IMPORT_EXTENSIONS = new Set([".csv", ".txt"]);
const IMPORT_MIME_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel"
]);

class ImportSecurityError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ImportSecurityError";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = "The import data could not be processed.";
  }
}

function rejectImport(code, message, statusCode) {
  throw new ImportSecurityError(code, message, statusCode);
}

function isFormulaLike(value) {
  return /^[\s\u0000-\u001F]*[=+@-]/.test(String(value || ""));
}

function validateImportMetadata({ fileName, mimeType } = {}) {
  if (fileName) {
    const extension = path.extname(String(fileName)).toLowerCase();
    if (!IMPORT_EXTENSIONS.has(extension)) {
      rejectImport("IMPORT_EXTENSION_NOT_ALLOWED", "Only .csv and .txt imports are allowed.", 415);
    }
  }
  if (mimeType) {
    const normalized = String(mimeType).split(";", 1)[0].trim().toLowerCase();
    if (!IMPORT_MIME_TYPES.has(normalized)) {
      rejectImport("IMPORT_MIME_NOT_ALLOWED", "The import MIME type is not allowed.", 415);
    }
  }
}

function validateImportSourceText(value) {
  const text = String(value || "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > IMPORT_LIMITS.maxBytes) {
    rejectImport("IMPORT_SIZE_LIMIT", "Import text exceeds the byte limit.", 413);
  }
  if (/\u0000/.test(text)) {
    rejectImport("IMPORT_BINARY_CONTENT", "Binary content is not allowed in text imports.");
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > IMPORT_LIMITS.maxRows + 1) {
    rejectImport("IMPORT_ROW_LIMIT", "Import text exceeds the row limit.");
  }
  if (lines.some((line) => line.length > IMPORT_LIMITS.maxLineCharacters)) {
    rejectImport("IMPORT_LINE_LIMIT", "Import text contains an oversized line.");
  }
  return text;
}

function validateCsvMatrix(rows) {
  if (!Array.isArray(rows)) rejectImport("IMPORT_STRUCTURE_INVALID", "CSV rows must be an array.");
  if (rows.length > IMPORT_LIMITS.maxRows + 1) rejectImport("IMPORT_ROW_LIMIT", "CSV exceeds the row limit.");

  let cells = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) rejectImport("IMPORT_STRUCTURE_INVALID", "CSV row is invalid.");
    if (row.length > IMPORT_LIMITS.maxColumns) rejectImport("IMPORT_COLUMN_LIMIT", "CSV exceeds the column limit.");
    cells += row.length;
    if (cells > IMPORT_LIMITS.maxCells) rejectImport("IMPORT_CELL_LIMIT", "CSV exceeds the cell limit.");
    for (const cell of row) {
      const text = String(cell || "");
      if (text.length > IMPORT_LIMITS.maxCellCharacters) rejectImport("IMPORT_CELL_SIZE_LIMIT", "CSV contains an oversized cell.");
      if (isFormulaLike(text)) rejectImport("IMPORT_FORMULA_BLOCKED", "Spreadsheet formulas are not allowed in imports.");
    }
  }
  return rows;
}

function publicImportError(error) {
  const statusCode = Number(error?.statusCode) || 500;
  const safeStatus = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return {
    statusCode: safeStatus,
    body: {
      error: error?.publicMessage || "The import data could not be processed.",
      code: typeof error?.code === "string" && error.code.startsWith("IMPORT_") ? error.code : "IMPORT_FAILED"
    }
  };
}

function parseYeogiImportSafely(sourceText, options = {}) {
  const text = validateImportSourceText(sourceText);
  const timeoutMs = Math.max(50, Number(options.timeoutMs || IMPORT_LIMITS.parseTimeoutMs));
  const workerPath = path.join(__dirname, "yeogi_import_worker.cjs");

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { sourceText: text } });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new ImportSecurityError("IMPORT_PARSE_TIMEOUT", "Import parsing timed out.", 408));
    }, timeoutMs);

    worker.once("message", (message) => {
      if (message?.ok) return finish(resolve, message.rows || []);
      finish(reject, new ImportSecurityError(message?.code || "IMPORT_PARSE_FAILED", message?.message || "Import parsing failed."));
    });
    worker.once("error", () => finish(reject, new ImportSecurityError("IMPORT_PARSE_FAILED", "Import parsing failed.", 500)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(reject, new ImportSecurityError("IMPORT_PARSE_FAILED", "Import parsing failed.", 500));
    });
  });
}

module.exports = {
  IMPORT_EXTENSIONS,
  IMPORT_LIMITS,
  IMPORT_MIME_TYPES,
  ImportSecurityError,
  isFormulaLike,
  parseYeogiImportSafely,
  publicImportError,
  validateCsvMatrix,
  validateImportMetadata,
  validateImportSourceText
};
