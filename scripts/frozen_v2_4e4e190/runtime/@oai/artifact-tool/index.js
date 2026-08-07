"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const writeExcelFile = require("write-excel-file/node");

const LIMITS = Object.freeze({
  maxSheets: 32,
  maxRowsPerSheet: 200000,
  maxColumnsPerSheet: 512,
  maxTotalCells: 2000000,
  maxCellTextLength: 32000
});

const WORKBOOK_BRAND = Symbol("frozen-v2-workbook");
const PROVIDER_URL_PATTERN = /https?:\/\/[^\s"'<>\])},]+/giu;

function normalizeSheetName(value) {
  return String(value || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
}

function stringifyCellObject(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeCellValue(value) {
  let safe = value;
  if (safe === null || safe === undefined) safe = "";
  else if (typeof safe === "number" && !Number.isFinite(safe)) safe = String(safe);
  else if (safe instanceof Date) safe = Number.isNaN(safe.getTime()) ? "" : safe.toISOString();
  else if (typeof safe === "bigint") safe = safe.toString();
  else if (typeof safe === "object") safe = stringifyCellObject(safe);
  else if (!["string", "number", "boolean"].includes(typeof safe)) safe = String(safe);

  if (typeof safe === "string" && PROVIDER_URL_PATTERN.test(safe)) {
    PROVIDER_URL_PATTERN.lastIndex = 0;
    safe = safe.replace(PROVIDER_URL_PATTERN, "[provider-url-removed]");
  }

  if (typeof safe === "string" && safe.length > LIMITS.maxCellTextLength) {
    const suffix = `...(truncated ${safe.length} chars)`;
    safe = `${safe.slice(0, Math.max(0, LIMITS.maxCellTextLength - suffix.length))}${suffix}`;
  }
  return safe;
}

function explicitCell(value) {
  const safe = safeCellValue(value);
  if (typeof safe === "number") return { value: safe, type: Number };
  if (typeof safe === "boolean") return { value: safe, type: Boolean };
  return { value: String(safe), type: String };
}

function columnCount(columnName) {
  let count = 0;
  for (const character of columnName) {
    count = count * 26 + character.charCodeAt(0) - 64;
  }
  return count;
}

function parseRange(reference) {
  const match = /^A1:([A-Z]+)([1-9]\d*)$/.exec(String(reference || "").toUpperCase());
  if (!match) throw new TypeError("frozen workbook bridge only supports rectangular ranges beginning at A1");
  const columns = columnCount(match[1]);
  const rows = Number.parseInt(match[2], 10);
  if (columns < 1 || columns > LIMITS.maxColumnsPerSheet) {
    throw new RangeError(`worksheet range exceeds ${LIMITS.maxColumnsPerSheet} columns`);
  }
  if (rows < 1 || rows > LIMITS.maxRowsPerSheet) {
    throw new RangeError(`worksheet range exceeds ${LIMITS.maxRowsPerSheet} rows`);
  }
  return Object.freeze({ reference: `A1:${match[1]}${rows}`, rows, columns });
}

function normalizeRangeValues(values, range) {
  if (!Array.isArray(values) || values.length !== range.rows) {
    throw new TypeError(`worksheet range ${range.reference} requires exactly ${range.rows} rows`);
  }
  return values.map((row, index) => {
    if (!Array.isArray(row) || row.length !== range.columns) {
      throw new TypeError(`worksheet range ${range.reference} row ${index + 1} requires exactly ${range.columns} columns`);
    }
    return row.map(safeCellValue);
  });
}

function createWorksheet(name) {
  const ranges = new Map();
  return Object.freeze({
    name,
    getRange(reference) {
      const range = parseRange(reference);
      let state = ranges.get(range.reference);
      if (!state) {
        state = { range, values: null };
        ranges.set(range.reference, state);
      }
      return {
        get values() {
          return state.values?.map((row) => [...row]) || null;
        },
        set values(value) {
          state.values = normalizeRangeValues(value, range);
        }
      };
    },
    _exportData() {
      if (ranges.size !== 1) throw new Error(`worksheet ${name} must contain exactly one populated range`);
      const [state] = ranges.values();
      if (!state.values) throw new Error(`worksheet ${name} does not contain exportable values`);
      return state.values.map((row) => row.map(explicitCell));
    },
    _cellCount() {
      if (ranges.size !== 1) return 0;
      const [state] = ranges.values();
      return state.values ? state.range.rows * state.range.columns : 0;
    }
  });
}

function createWorkbook() {
  const sheets = [];
  const names = new Set();
  const workbook = {
    [WORKBOOK_BRAND]: true,
    worksheets: Object.freeze({
      add(requestedName) {
        if (sheets.length >= LIMITS.maxSheets) throw new RangeError(`workbook exceeds ${LIMITS.maxSheets} sheets`);
        const name = normalizeSheetName(requestedName);
        const key = name.toLocaleLowerCase("en-US");
        if (names.has(key)) throw new Error(`duplicate workbook sheet name: ${name}`);
        const worksheet = createWorksheet(name);
        names.add(key);
        sheets.push(worksheet);
        return worksheet;
      }
    }),
    _exportSheets() {
      if (!sheets.length) throw new Error("workbook requires at least one sheet");
      let totalCells = 0;
      const output = sheets.map((sheet) => {
        totalCells += sheet._cellCount();
        if (totalCells > LIMITS.maxTotalCells) {
          throw new RangeError(`workbook exceeds ${LIMITS.maxTotalCells} cells`);
        }
        return { sheet: sheet.name, data: sheet._exportData() };
      });
      return output;
    }
  };
  return Object.freeze(workbook);
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function configuredOutputRoot() {
  const configured = process.env.FROZEN_V2_WORKBOOK_ROOT || process.env.OUTPUTS_DIR || process.env.DATA_DIR || "";
  if (!configured) return null;
  if (!path.isAbsolute(configured)) throw new TypeError("frozen workbook output root must be absolute");
  return path.resolve(configured);
}

async function validatedOutputPath(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) throw new TypeError("frozen workbook output path must be absolute");
  if (path.extname(filePath).toLowerCase() !== ".xlsx") {
    throw new TypeError("frozen workbook output must use the .xlsx extension");
  }
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  const root = configuredOutputRoot();
  if (root && !isContainedPath(root, target)) throw new Error("frozen workbook output escapes its configured root");

  const [parentReal, rootReal] = await Promise.all([
    fsp.realpath(parent),
    root ? fsp.realpath(root) : Promise.resolve(null)
  ]);
  if (rootReal && !isContainedPath(rootReal, parentReal)) {
    throw new Error("frozen workbook output resolves outside its configured root");
  }
  try {
    const existing = await fsp.lstat(target);
    if (existing.isSymbolicLink()) throw new Error("frozen workbook output cannot replace a symbolic link");
    throw new Error("frozen workbook output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

const Workbook = Object.freeze({ create: createWorkbook });

const SpreadsheetFile = Object.freeze({
  async exportXlsx(workbook) {
    if (!workbook || workbook[WORKBOOK_BRAND] !== true || typeof workbook._exportSheets !== "function") {
      throw new TypeError("exportXlsx requires a frozen workbook bridge instance");
    }
    const sheets = workbook._exportSheets();
    return Object.freeze({
      async save(filePath) {
        const safePath = await validatedOutputPath(filePath);
        await writeExcelFile(sheets).toFile(safePath);
      }
    });
  }
});

module.exports = { Workbook, SpreadsheetFile };
