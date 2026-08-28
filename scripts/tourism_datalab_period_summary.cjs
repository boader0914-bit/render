const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const ADAPTER_VERSION = "kto-datalab-download-v1";
const SCHEMA_VERSION = 1;
const SOURCE_LABEL = "한국관광 데이터랩 공식 다운로드";
const POLICY = Object.freeze({
  scoreApplied: false,
  monthlySigunguHistoryAvailable: false,
  compatibleWithVisitorMonthlyCache: false,
  missingIsNotZero: true
});

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 20 * 1024 * 1024,
  maxEntries: 16,
  maxCompressedEntryBytes: 10 * 1024 * 1024,
  maxUncompressedEntryBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxSnapshotBytes: 50 * 1024 * 1024
});

const REQUIRED_CSVS = Object.freeze({
  heatmap: "방문자수 히트맵.csv",
  local: "지역별 방문자 수(기초지자체별).csv",
  broad: "지역별 방문자 수(광역별).csv",
  trend: "방문자 수 추이.csv"
});

const CSV_HEADERS = Object.freeze({
  heatmap: Object.freeze(["광역지자체", "방문자 수"]),
  local: Object.freeze([
    "광역지자체명",
    "기초지자체명",
    "광역지자체 방문자 수",
    "광역지자체 방문자 비율",
    "기초지자체 방문자 수",
    "기초지자체 방문자 비율"
  ]),
  broad: Object.freeze(["광역지자체명", "광역지자체 방문자 수", "광역지자체 방문자 비율"]),
  trend: Object.freeze(["기준년월", "광역지자체", "방문자 구분", "방문자 수"])
});

const TREND_CATEGORY_FIELDS = Object.freeze({
  "현지인방문자(a)": "residentVisitors",
  "외지인방문자(b)": "nonResidentVisitors",
  "전체방문자(a+b)": "totalVisitors"
});

const FORBIDDEN_INCHEON_PREDECESSORS = new Set(["중구", "동구", "서구"]);
const PROVINCE_SUCCESSORS = new Map([
  ["광주광역시", "전남광주통합특별시"],
  ["전라남도", "전남광주통합특별시"]
]);

class PeriodSummaryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PeriodSummaryError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PeriodSummaryError(code, message, details);
}

function roundNumber(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      return value >>> 0;
    });
  }
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function strictYearMonth(value, fieldName = "yearMonth") {
  const normalized = String(value || "").trim();
  if (!/^\d{6}$/.test(normalized)) fail("invalid_period", `${fieldName} must use YYYYMM.`);
  const month = Number(normalized.slice(4, 6));
  if (month < 1 || month > 12) fail("invalid_period", `${fieldName} contains an invalid month.`);
  return normalized;
}

function shiftYearMonth(value, offset) {
  const yearMonth = strictYearMonth(value);
  const date = new Date(Date.UTC(
    Number(yearMonth.slice(0, 4)),
    Number(yearMonth.slice(4, 6)) - 1 + Number(offset || 0),
    1
  ));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(startYearMonth, endYearMonth) {
  const start = strictYearMonth(startYearMonth, "startYearMonth");
  const end = strictYearMonth(endYearMonth, "endYearMonth");
  const startIndex = Number(start.slice(0, 4)) * 12 + Number(start.slice(4, 6)) - 1;
  const endIndex = Number(end.slice(0, 4)) * 12 + Number(end.slice(4, 6)) - 1;
  return endIndex - startIndex + 1;
}

function parseArchiveFileName(filePath) {
  const fileName = path.basename(String(filePath || ""));
  const match = /^(\d{14})__(\d{6})-(\d{6})_데이터랩_다운로드\.zip$/u.exec(fileName);
  if (!match) {
    fail(
      "invalid_archive_name",
      "Archive name must be TIMESTAMP__YYYYMM-YYYYMM_데이터랩_다운로드.zip."
    );
  }
  const [, timestamp, startYearMonthRaw, endYearMonthRaw] = match;
  const startYearMonth = strictYearMonth(startYearMonthRaw, "startYearMonth");
  const endYearMonth = strictYearMonth(endYearMonthRaw, "endYearMonth");
  const monthCount = monthsBetween(startYearMonth, endYearMonth);
  if (monthCount !== 12) fail("invalid_period", "The official period summary must cover exactly 12 consecutive months.");

  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(4, 6));
  const day = Number(timestamp.slice(6, 8));
  const hour = Number(timestamp.slice(8, 10));
  const minute = Number(timestamp.slice(10, 12));
  const second = Number(timestamp.slice(12, 14));
  const candidate = new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
  const kst = new Date(candidate.getTime() + 9 * 60 * 60 * 1000);
  if (
    kst.getUTCFullYear() !== year
    || kst.getUTCMonth() + 1 !== month
    || kst.getUTCDate() !== day
    || kst.getUTCHours() !== hour
    || kst.getUTCMinutes() !== minute
    || kst.getUTCSeconds() !== second
  ) {
    fail("invalid_archive_name", "Archive timestamp is not a valid KST date and time.");
  }

  return {
    fileName,
    timestamp,
    downloadedAt: candidate.toISOString(),
    startYearMonth,
    endYearMonth,
    monthCount
  };
}

function mergeLimits(overrides = {}) {
  const merged = { ...DEFAULT_LIMITS };
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    if (overrides[key] === undefined) continue;
    const candidate = Number(overrides[key]);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      fail("invalid_limit", `${key} must be a positive safe integer.`);
    }
    merged[key] = candidate;
  }
  return merged;
}

function hasZip64Extra(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) fail("invalid_zip", "Malformed ZIP extra field.");
    const fieldId = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) fail("invalid_zip", "Malformed ZIP extra field length.");
    if (fieldId === 0x0001) return true;
    offset += size;
  }
  return false;
}

function decodeZipName(nameBytes, flags) {
  if (!(flags & 0x0800) && nameBytes.some((byte) => byte > 0x7f)) {
    fail("unsupported_zip_encoding", "Non-ASCII ZIP names must use the UTF-8 flag.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    fail("invalid_zip_name", "ZIP entry name is not valid UTF-8.");
  }
}

function validateZipBaseName(fileName) {
  if (!fileName || fileName.includes("\0")) fail("unsafe_zip_path", "ZIP entry has an empty or NUL name.");
  if (
    fileName.includes("/")
    || fileName.includes("\\")
    || fileName === "."
    || fileName === ".."
    || /^[a-zA-Z]:/.test(fileName)
    || path.isAbsolute(fileName)
  ) {
    fail("unsafe_zip_path", "ZIP entries must be plain file names without directories.", { fileName });
  }
  return fileName.normalize("NFC");
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  fail("invalid_zip", "ZIP end-of-central-directory record was not found.");
}

function readSafeZipBuffer(archive, limitOverrides = {}) {
  const limits = mergeLimits(limitOverrides);
  if (!Buffer.isBuffer(archive)) fail("invalid_zip", "ZIP input must be a Buffer.");
  if (archive.length > limits.maxArchiveBytes) fail("archive_too_large", "ZIP archive exceeds the configured size limit.");
  if (archive.length < 22) fail("invalid_zip", "ZIP archive is truncated.");

  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("unsupported_zip", "Multi-disk ZIP archives are not supported.");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("unsupported_zip", "ZIP64 archives are not supported.");
  }
  if (entryCount < 1 || entryCount > limits.maxEntries) {
    fail("zip_entry_limit", "ZIP entry count is outside the configured limit.", { entryCount });
  }
  if (centralOffset + centralSize !== eocdOffset || centralOffset > archive.length) {
    fail("invalid_zip", "ZIP central directory bounds are invalid.");
  }

  const descriptors = [];
  const seenNames = new Set();
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      fail("invalid_zip", "ZIP central directory entry is malformed.", { index });
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocdOffset || nameLength < 1) fail("invalid_zip", "ZIP central directory entry is truncated.");
    if (diskStart !== 0) fail("unsupported_zip", "Multi-disk ZIP entries are not supported.");
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || hasZip64Extra(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    ) {
      fail("unsupported_zip", "ZIP64 entries are not supported.");
    }
    if ((flags & 0x0001) || (flags & 0x0040)) fail("encrypted_zip", "Encrypted ZIP entries are not supported.");
    if (![0, 8].includes(compressionMethod)) {
      fail("unsupported_compression", "Only stored and deflate ZIP entries are supported.", { compressionMethod });
    }
    if (compressedSize > limits.maxCompressedEntryBytes) fail("compressed_entry_too_large", "Compressed ZIP entry exceeds the configured limit.");
    if (uncompressedSize > limits.maxUncompressedEntryBytes) fail("entry_too_large", "Uncompressed ZIP entry exceeds the configured limit.");
    if (uncompressedSize > compressedSize * limits.maxCompressionRatio && uncompressedSize > limits.maxCompressionRatio) {
      fail("compression_ratio_exceeded", "ZIP entry compression ratio exceeds the configured limit.");
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressedBytes) fail("zip_total_size_exceeded", "ZIP total uncompressed size exceeds the configured limit.");

    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const fileName = validateZipBaseName(decodeZipName(rawName, flags));
    if (seenNames.has(fileName)) fail("duplicate_zip_entry", "ZIP archive contains duplicate entry names.", { fileName });
    seenNames.add(fileName);
    descriptors.push({
      fileName,
      flags,
      compressionMethod,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    cursor = end;
  }
  if (cursor !== eocdOffset) fail("invalid_zip", "ZIP central directory contains trailing unsupported records.");

  let actualTotal = 0;
  return descriptors.map((descriptor) => {
    const { localOffset } = descriptor;
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("invalid_zip", "ZIP local file header is malformed.", { fileName: descriptor.fileName });
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localCompression = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const headerEnd = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = headerEnd + descriptor.compressedSize;
    if (headerEnd > centralOffset || dataEnd > centralOffset) {
      fail("invalid_zip", "ZIP entry data extends outside the local-file area.", { fileName: descriptor.fileName });
    }
    if (localFlags !== descriptor.flags || localCompression !== descriptor.compressionMethod) {
      fail("invalid_zip", "ZIP local and central metadata do not match.", { fileName: descriptor.fileName });
    }
    const localName = validateZipBaseName(decodeZipName(
      archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      localFlags
    ));
    if (localName !== descriptor.fileName) fail("invalid_zip", "ZIP local and central names do not match.");
    if (hasZip64Extra(archive.subarray(localOffset + 30 + localNameLength, headerEnd))) {
      fail("unsupported_zip", "ZIP64 entries are not supported.");
    }

    const compressed = archive.subarray(headerEnd, dataEnd);
    let data;
    if (descriptor.compressionMethod === 0) {
      if (descriptor.compressedSize !== descriptor.uncompressedSize) fail("invalid_zip", "Stored ZIP entry sizes do not match.");
      data = Buffer.from(compressed);
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxUncompressedEntryBytes });
      } catch (error) {
        fail("invalid_deflate", "ZIP deflate stream could not be decoded.", { message: error.message });
      }
    }
    if (data.length !== descriptor.uncompressedSize) fail("invalid_zip", "ZIP entry uncompressed size does not match.");
    if (crc32(data) !== descriptor.expectedCrc) fail("crc_mismatch", "ZIP entry CRC32 does not match.", { fileName: descriptor.fileName });
    actualTotal += data.length;
    if (actualTotal > limits.maxTotalUncompressedBytes) fail("zip_total_size_exceeded", "ZIP total uncompressed size exceeds the configured limit.");
    return {
      fileName: descriptor.fileName,
      compressionMethod: descriptor.compressionMethod,
      compressedSize: descriptor.compressedSize,
      uncompressedSize: data.length,
      sha256: sha256(data),
      data
    };
  });
}

async function readSafeZip(filePath, limitOverrides = {}) {
  const limits = mergeLimits(limitOverrides);
  const resolved = path.resolve(String(filePath || ""));
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    fail("archive_not_found", "ZIP archive was not found.", { filePath: resolved });
  }
  if (!stat.isFile()) fail("invalid_archive", "ZIP archive path must point to a file.");
  if (stat.size > limits.maxArchiveBytes) fail("archive_too_large", "ZIP archive exceeds the configured size limit.");
  return readSafeZipBuffer(await fsp.readFile(resolved), limits);
}

function decodeUtf8Csv(buffer, fileName) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("invalid_csv_encoding", "CSV must be valid UTF-8.", { fileName });
  }
  return text.replace(/^\uFEFF/, "");
}

function parseCsv(text, fileName = "CSV") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  let hasContent = false;

  const pushRow = () => {
    row.push(field);
    if (row.length === 1 && row[0] === "") {
      if (rows.length) fail("blank_csv_row", "CSV contains a blank row.", { fileName });
    } else {
      rows.push(row);
    }
    row = [];
    field = "";
    justClosedQuote = false;
    hasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      hasContent = true;
      continue;
    }

    if (character === '"') {
      if (field !== "" || justClosedQuote) fail("invalid_csv", "Unexpected quote in CSV field.", { fileName });
      quoted = true;
      hasContent = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      justClosedQuote = false;
      hasContent = true;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      if (justClosedQuote) fail("invalid_csv", "Characters follow a closing CSV quote.", { fileName });
      field += character;
      hasContent = true;
    }
  }
  if (quoted) fail("invalid_csv", "CSV has an unterminated quoted field.", { fileName });
  if (hasContent || row.length || field !== "") pushRow();
  if (!rows.length) fail("empty_csv", "CSV is empty.", { fileName });
  return rows;
}

function recordsWithExactHeaders(rows, expectedHeaders, fileName) {
  const actualHeaders = rows[0].map((value) => String(value || "").trim());
  if (
    actualHeaders.length !== expectedHeaders.length
    || actualHeaders.some((value, index) => value !== expectedHeaders[index])
    || new Set(actualHeaders).size !== actualHeaders.length
  ) {
    fail("unexpected_csv_headers", "CSV headers do not match the official export contract.", {
      fileName,
      expectedHeaders,
      actualHeaders
    });
  }
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== expectedHeaders.length) {
      fail("invalid_csv_row", "CSV row length does not match its header.", { fileName, rowNumber: rowIndex + 2 });
    }
    return Object.fromEntries(expectedHeaders.map((header, index) => [header, String(values[index] || "").trim()]));
  });
}

function parseNumeric(value, { fieldName, integer = false, percent = false } = {}) {
  let normalized = String(value ?? "").trim();
  if (percent && normalized.endsWith("%")) normalized = normalized.slice(0, -1).trim();
  normalized = normalized.replace(/,/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    fail("invalid_number", `${fieldName || "value"} is not numeric.`, { value });
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric < 0) fail("invalid_number", `${fieldName || "value"} must be finite and non-negative.`);
  if (percent && numeric > 100) fail("invalid_percentage", `${fieldName || "value"} must be between 0 and 100.`);
  if (integer) {
    const rounded = Math.round(numeric);
    if (!Number.isSafeInteger(rounded) || Math.abs(numeric - rounded) > 1e-6) {
      fail("invalid_count", `${fieldName || "value"} must be a safe integer count.`);
    }
    return rounded;
  }
  return numeric;
}

function nonEmpty(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) fail("missing_value", `${fieldName} is required.`);
  return normalized;
}

function identifyRequiredEntries(entries, timestamp) {
  if (entries.length !== Object.keys(REQUIRED_CSVS).length) {
    fail("unexpected_archive_entries", "Official archive must contain exactly four CSV files.", { entryCount: entries.length });
  }
  const byKind = {};
  for (const entry of entries) {
    const match = /^(\d{14})_(.+\.csv)$/u.exec(entry.fileName);
    if (!match || match[1] !== timestamp) fail("unexpected_archive_entry", "CSV file name does not match the archive timestamp.", { fileName: entry.fileName });
    const kind = Object.entries(REQUIRED_CSVS).find(([, suffix]) => match[2] === suffix)?.[0];
    if (!kind || byKind[kind]) fail("unexpected_archive_entry", "ZIP contains an unexpected or duplicate CSV file.", { fileName: entry.fileName });
    byKind[kind] = entry;
  }
  for (const kind of Object.keys(REQUIRED_CSVS)) {
    if (!byKind[kind]) fail("missing_archive_entry", `ZIP is missing ${REQUIRED_CSVS[kind]}.`);
  }
  return byKind;
}

function normalizeOfficialCsvs(entriesByKind) {
  const parsed = {};
  for (const [kind, entry] of Object.entries(entriesByKind)) {
    const rows = parseCsv(decodeUtf8Csv(entry.data, entry.fileName), entry.fileName);
    parsed[kind] = recordsWithExactHeaders(rows, CSV_HEADERS[kind], entry.fileName);
  }

  const heatmap = parsed.heatmap.map((row) => ({
    sourceProvinceName: nonEmpty(row["광역지자체"], "광역지자체"),
    visitorCount: parseNumeric(row["방문자 수"], { fieldName: "방문자 수", integer: true })
  }));
  const broad = parsed.broad.map((row) => ({
    sourceProvinceName: nonEmpty(row["광역지자체명"], "광역지자체명"),
    visitorCount: parseNumeric(row["광역지자체 방문자 수"], { fieldName: "광역지자체 방문자 수", integer: true }),
    nationalSharePct: parseNumeric(row["광역지자체 방문자 비율"], { fieldName: "광역지자체 방문자 비율", percent: true })
  }));
  const local = parsed.local.map((row) => ({
    sourceProvinceName: nonEmpty(row["광역지자체명"], "광역지자체명"),
    sourceLocalName: nonEmpty(row["기초지자체명"], "기초지자체명"),
    provinceVisitorCount: parseNumeric(row["광역지자체 방문자 수"], { fieldName: "광역지자체 방문자 수", integer: true }),
    provinceNationalSharePct: parseNumeric(row["광역지자체 방문자 비율"], { fieldName: "광역지자체 방문자 비율", percent: true }),
    visitorCount: parseNumeric(row["기초지자체 방문자 수"], { fieldName: "기초지자체 방문자 수", integer: true }),
    localWithinProvinceSharePct: parseNumeric(row["기초지자체 방문자 비율"], { fieldName: "기초지자체 방문자 비율", percent: true })
  }));

  const trendByMonth = new Map();
  for (const row of parsed.trend) {
    const yearMonth = strictYearMonth(row["기준년월"], "기준년월");
    const sourceProvinceName = nonEmpty(row["광역지자체"], "광역지자체");
    if (sourceProvinceName !== "전국") fail("unsupported_trend_region", "Period trend CSV must contain national rows only.");
    const category = nonEmpty(row["방문자 구분"], "방문자 구분");
    const field = TREND_CATEGORY_FIELDS[category];
    if (!field) fail("unexpected_trend_category", "Trend CSV contains an unknown visitor category.", { category });
    const bucket = trendByMonth.get(yearMonth) || { yearMonth, sourceProvinceName };
    if (bucket[field] !== undefined) fail("duplicate_trend_row", "Trend CSV contains a duplicate month/category row.", { yearMonth, category });
    bucket[field] = parseNumeric(row["방문자 수"], { fieldName: "방문자 수", integer: true });
    trendByMonth.set(yearMonth, bucket);
  }
  const nationalMonthlyTrend = [...trendByMonth.values()].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  for (const row of nationalMonthlyTrend) {
    for (const field of Object.values(TREND_CATEGORY_FIELDS)) {
      if (!Number.isSafeInteger(row[field])) fail("missing_trend_category", "Trend month is missing a visitor category.", { yearMonth: row.yearMonth, field });
    }
  }
  return { heatmap, broad, local, nationalMonthlyTrend };
}

async function readJsonFile(filePath, errorCode) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    fail(errorCode, `Required JSON file could not be read: ${path.basename(filePath)}`, { message: error.message });
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(errorCode, `Required JSON file is not valid JSON: ${path.basename(filePath)}`, { message: error.message });
  }
}

function unitIdentity(unit) {
  if (!unit) return null;
  return {
    regionKey: unit.regionKey,
    fullName: unit.fullName || unit.name || "",
    name: unit.name || "",
    level: unit.level || "",
    officialCode: unit.officialCode || "",
    active: unit.active === true
  };
}

function buildRegionResolver(master) {
  if (!master || !Array.isArray(master.units)) fail("invalid_region_master", "region_master.json must contain a units array.");
  const units = master.units.filter((unit) => unit && typeof unit === "object" && unit.regionKey);
  const activeUnits = units.filter((unit) => unit.active === true && unit.status !== "retired");

  const activeByFullName = new Map();
  const historicalByFullName = new Map();
  for (const unit of units) {
    const fullName = String(unit.fullName || "").trim();
    if (!fullName) continue;
    const target = unit.active === true && unit.status !== "retired" ? activeByFullName : historicalByFullName;
    const bucket = target.get(fullName) || [];
    bucket.push(unit);
    target.set(fullName, bucket);
  }

  function preferred(candidates = [], level = "") {
    return [...candidates]
      .filter((unit) => !level || unit.level === level)
      .sort((left, right) => {
        const selectableDelta = Number(Boolean(right.selectable)) - Number(Boolean(left.selectable));
        if (selectableDelta) return selectableDelta;
        return String(right.officialCode || "").localeCompare(String(left.officialCode || ""));
      })[0] || null;
  }

  function result({ current = null, historical = null, status, reason }) {
    return {
      regionKey: current?.regionKey || historical?.regionKey || null,
      currentRegionKey: current?.regionKey || null,
      historicalRegionKey: historical?.regionKey || null,
      currentRegion: unitIdentity(current),
      historicalRegion: unitIdentity(historical),
      mappingStatus: status,
      mappingReason: reason
    };
  }

  function broad(sourceProvinceName) {
    const source = String(sourceProvinceName || "").trim();
    const active = preferred(activeByFullName.get(source), "broad");
    if (active) return result({ current: active, status: "exact", reason: "active_full_name_exact" });

    const successorName = PROVINCE_SUCCESSORS.get(source);
    if (successorName) {
      const successor = preferred(activeByFullName.get(successorName), "broad");
      const historical = preferred(historicalByFullName.get(source), "broad");
      if (successor) {
        return result({
          current: successor,
          historical,
          status: "province-successor",
          reason: `${source}_to_${successorName}`
        });
      }
    }

    const historical = preferred(historicalByFullName.get(source), "broad");
    if (historical) return result({ historical, status: "historical", reason: "historical_full_name_exact" });
    return result({ status: "unalignable", reason: "no_region_master_alignment" });
  }

  function local(sourceProvinceName, sourceLocalName) {
    const province = String(sourceProvinceName || "").trim();
    const localName = String(sourceLocalName || "").trim();
    const fullName = `${province} ${localName}`.trim();

    if (province === "인천광역시" && FORBIDDEN_INCHEON_PREDECESSORS.has(localName)) {
      const historical = preferred(historicalByFullName.get(fullName), "local");
      return result({
        historical,
        status: "unalignable",
        reason: "incheon_predecessor_boundary_not_allocated"
      });
    }

    const active = preferred(activeByFullName.get(fullName), "local");
    if (active) return result({ current: active, status: "exact", reason: "active_full_name_exact" });

    // 세종은 광역과 기초가 같은 이름으로 내려오는 단층 행정구역이다.
    if (province === localName) {
      const singleTier = preferred(activeByFullName.get(province), "broad");
      if (singleTier) return result({ current: singleTier, status: "exact", reason: "single_tier_city_province" });
    }

    const successorName = PROVINCE_SUCCESSORS.get(province);
    if (successorName) {
      const successor = activeUnits.find((unit) => (
        unit.level === "local"
        && String(unit.sidoFull || "") === successorName
        && String(unit.name || unit.sigungu || "") === localName
      )) || null;
      const historical = preferred(historicalByFullName.get(fullName), "local");
      if (successor) {
        return result({
          current: successor,
          historical,
          status: "province-successor",
          reason: `${province}_to_${successorName}`
        });
      }
    }

    const historical = preferred(historicalByFullName.get(fullName), "local");
    if (historical) return result({ historical, status: "historical", reason: "historical_full_name_exact" });
    return result({ status: "unalignable", reason: "no_region_master_alignment" });
  }

  function byRegionKey(regionKey) {
    return units.find((unit) => unit.regionKey === regionKey) || null;
  }

  return { broad, local, byRegionKey, version: master.version || "unknown" };
}

function assertUnique(rows, keyFn, code, label) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) fail(code, `${label} contains a duplicate row.`, { key });
    seen.add(key);
  }
}

function buildQualityAndValidate(normalized, period) {
  const { heatmap, broad, local, nationalMonthlyTrend } = normalized;
  assertUnique(heatmap, (row) => row.sourceProvinceName, "duplicate_heatmap_region", "Heatmap CSV");
  assertUnique(broad, (row) => row.sourceProvinceName, "duplicate_broad_region", "Broad-region CSV");
  assertUnique(local, (row) => `${row.sourceProvinceName}\u0000${row.sourceLocalName}`, "duplicate_local_region", "Local-region CSV");
  assertUnique(nationalMonthlyTrend, (row) => row.yearMonth, "duplicate_trend_month", "Trend CSV");

  const broadByName = new Map(broad.map((row) => [row.sourceProvinceName, row]));
  const heatmapByName = new Map(heatmap.map((row) => [row.sourceProvinceName, row]));
  if (broad.length !== heatmap.length) fail("heatmap_broad_mismatch", "Heatmap and broad-region counts differ.");
  for (const row of broad) {
    const heatmapRow = heatmapByName.get(row.sourceProvinceName);
    if (!heatmapRow || heatmapRow.visitorCount !== row.visitorCount) {
      fail("heatmap_broad_mismatch", "Heatmap count does not match the broad-region CSV.", { sourceProvinceName: row.sourceProvinceName });
    }
  }

  const localShareSums = new Map();
  for (const row of local) {
    const broadRow = broadByName.get(row.sourceProvinceName);
    if (!broadRow) fail("local_broad_mismatch", "Local row refers to a province missing from the broad-region CSV.", { sourceProvinceName: row.sourceProvinceName });
    if (
      broadRow.visitorCount !== row.provinceVisitorCount
      || Math.abs(broadRow.nationalSharePct - row.provinceNationalSharePct) > 1e-9
    ) {
      fail("local_broad_mismatch", "Repeated province values in the local CSV do not match the broad-region CSV.", { sourceProvinceName: row.sourceProvinceName });
    }
    localShareSums.set(
      row.sourceProvinceName,
      (localShareSums.get(row.sourceProvinceName) || 0) + row.localWithinProvinceSharePct
    );
  }
  for (const sourceProvinceName of broadByName.keys()) {
    if (!localShareSums.has(sourceProvinceName)) fail("missing_local_coverage", "Province has no local-region rows.", { sourceProvinceName });
  }

  const broadShareSum = broad.reduce((sum, row) => sum + row.nationalSharePct, 0);
  if (Math.abs(broadShareSum - 100) > 0.5) fail("invalid_broad_share_sum", "Broad-region visitor shares do not sum to approximately 100%.", { broadShareSum });
  let maximumLocalShareDeviation = 0;
  for (const [sourceProvinceName, sum] of localShareSums) {
    maximumLocalShareDeviation = Math.max(maximumLocalShareDeviation, Math.abs(sum - 100));
    if (Math.abs(sum - 100) > 1) {
      fail("invalid_local_share_sum", "Local visitor shares do not sum to approximately 100% within a province.", { sourceProvinceName, sum });
    }
  }

  const expectedMonths = Array.from({ length: period.monthCount }, (_, index) => shiftYearMonth(period.startYearMonth, index));
  if (
    nationalMonthlyTrend.length !== expectedMonths.length
    || nationalMonthlyTrend.some((row, index) => row.yearMonth !== expectedMonths[index])
  ) {
    fail("trend_period_mismatch", "National trend months do not exactly match the archive period.");
  }
  let maximumTrendIdentityDifference = 0;
  for (const row of nationalMonthlyTrend) {
    const difference = Math.abs(row.totalVisitors - row.residentVisitors - row.nonResidentVisitors);
    maximumTrendIdentityDifference = Math.max(maximumTrendIdentityDifference, difference);
    if (difference > 1) fail("trend_identity_mismatch", "National total differs from resident plus non-resident visitors by more than one.", { yearMonth: row.yearMonth, difference });
  }

  // 전국 다운로드가 잘려 들어오는 것을 방지한다. 행정개편에 따라 정확한 개수는 변할 수 있어 하한만 둔다.
  if (broad.length < 16 || local.length < 220) {
    fail("incomplete_national_export", "Official download appears incomplete for nationwide coverage.", {
      broadRegionCount: broad.length,
      localRegionCount: local.length
    });
  }

  return {
    status: "complete",
    expectedEntryCount: 4,
    entryCount: 4,
    broadRegionCount: broad.length,
    localRegionCount: local.length,
    trendMonthCount: nationalMonthlyTrend.length,
    checks: {
      exactHeaders: true,
      noDuplicateRegions: true,
      heatmapMatchesBroadRegions: true,
      localProvinceValuesMatchBroadRegions: true,
      broadShareSumPct: roundNumber(broadShareSum, 4),
      maximumLocalShareDeviationPct: roundNumber(maximumLocalShareDeviation, 4),
      trendMonthsMatchPeriod: true,
      maximumTrendIdentityDifference,
      nationalCoverageFloorMet: true
    }
  };
}

function mappingCounts(rows) {
  const counts = { exact: 0, historical: 0, "province-successor": 0, unalignable: 0 };
  for (const row of rows) counts[row.mappingStatus] = (counts[row.mappingStatus] || 0) + 1;
  return counts;
}

function mapBroadRegions(rows, resolver) {
  return rows.map((row) => ({
    ...resolver.broad(row.sourceProvinceName),
    sourceProvinceName: row.sourceProvinceName,
    visitorCount: row.visitorCount,
    provinceVisitorCount: row.visitorCount,
    provinceNationalSharePct: row.nationalSharePct,
    nationalSharePct: row.nationalSharePct,
    sourceLocalName: null,
    localWithinProvinceSharePct: null
  }));
}

function mapLocalRegions(rows, resolver) {
  return rows.map((row) => ({
    ...resolver.local(row.sourceProvinceName, row.sourceLocalName),
    ...row
  }));
}

function sourceEntrySummary(entriesByKind, normalized) {
  return Object.entries(entriesByKind)
    .map(([kind, entry]) => ({
      kind,
      fileName: entry.fileName,
      sha256: entry.sha256,
      rowCount: kind === "trend"
        ? normalized.nationalMonthlyTrend.length * Object.keys(TREND_CATEGORY_FIELDS).length
        : normalized[kind].length
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function buildSnapshot({ archiveInfo, archiveSha256, entriesByKind, normalized, resolver, collectedAt }) {
  const period = {
    startYearMonth: archiveInfo.startYearMonth,
    endYearMonth: archiveInfo.endYearMonth,
    monthCount: archiveInfo.monthCount
  };
  const quality = buildQualityAndValidate(normalized, period);
  const broadRegions = mapBroadRegions(normalized.broad, resolver);
  const localRegions = mapLocalRegions(normalized.local, resolver);
  const localMappings = mappingCounts(localRegions);
  const broadMappings = mappingCounts(broadRegions);

  return {
    schemaVersion: SCHEMA_VERSION,
    adapter: ADAPTER_VERSION,
    status: "ok",
    reason: "",
    collectedAt,
    period,
    source: {
      key: "visitors",
      label: SOURCE_LABEL,
      type: "official_datalab_download",
      archiveFileName: archiveInfo.fileName,
      archiveSha256,
      downloadedAt: archiveInfo.downloadedAt,
      entries: sourceEntrySummary(entriesByKind, normalized)
    },
    broadRegions,
    localRegions,
    nationalMonthlyTrend: normalized.nationalMonthlyTrend,
    quality: {
      ...quality,
      regionMasterVersion: resolver.version,
      mappingCounts: {
        broad: broadMappings,
        local: localMappings
      },
      exactMappingCount: localMappings.exact || 0,
      historicalMappingCount: localMappings.historical || 0,
      provinceSuccessorMappingCount: localMappings["province-successor"] || 0,
      unalignableMappingCount: localMappings.unalignable || 0
    },
    policy: { ...POLICY }
  };
}

function summaryFileName(startYearMonth, endYearMonth) {
  return `${ADAPTER_VERSION}__${strictYearMonth(startYearMonth, "startYearMonth")}__${strictYearMonth(endYearMonth, "endYearMonth")}.json`;
}

function validStoredCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStoredPercent(value, nullable = false) {
  if (nullable && value === null) return true;
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function assertStoredSnapshotShape(snapshot, filePath) {
  const invalid = (reason) => fail("invalid_snapshot", `Period summary failed deep validation: ${reason}.`, { filePath });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid("root object");
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.adapter !== ADAPTER_VERSION || snapshot.status !== "ok") invalid("version or status");
  const period = snapshot.period;
  if (
    !period
    || !/^\d{6}$/.test(String(period.startYearMonth || ""))
    || !/^\d{6}$/.test(String(period.endYearMonth || ""))
    || Number(period.startYearMonth.slice(4, 6)) < 1
    || Number(period.startYearMonth.slice(4, 6)) > 12
    || Number(period.endYearMonth.slice(4, 6)) < 1
    || Number(period.endYearMonth.slice(4, 6)) > 12
  ) invalid("period");
  const startIndex = Number(period.startYearMonth.slice(0, 4)) * 12 + Number(period.startYearMonth.slice(4, 6)) - 1;
  const endIndex = Number(period.endYearMonth.slice(0, 4)) * 12 + Number(period.endYearMonth.slice(4, 6)) - 1;
  if (period.monthCount !== 12 || endIndex - startIndex + 1 !== 12) invalid("12-month window");
  if (!Number.isFinite(Date.parse(snapshot.collectedAt || ""))) invalid("collectedAt");
  if (
    snapshot.source?.label !== SOURCE_LABEL
    || !/^[a-f0-9]{64}$/.test(String(snapshot.source?.archiveSha256 || ""))
  ) invalid("source evidence");
  for (const [key, expected] of Object.entries(POLICY)) {
    if (snapshot.policy?.[key] !== expected) invalid(`policy.${key}`);
  }
  if (!Array.isArray(snapshot.broadRegions) || !Array.isArray(snapshot.localRegions) || !Array.isArray(snapshot.nationalMonthlyTrend)) invalid("data arrays");
  if (snapshot.broadRegions.length < 16 || snapshot.localRegions.length < 220 || snapshot.nationalMonthlyTrend.length !== 12) invalid("coverage counts");

  const mappingStatuses = new Set(["exact", "historical", "province-successor", "unalignable"]);
  const broadSeen = new Set();
  for (const row of snapshot.broadRegions) {
    if (!row || !String(row.sourceProvinceName || "").trim() || broadSeen.has(row.sourceProvinceName)) invalid("broad source identity");
    broadSeen.add(row.sourceProvinceName);
    if (!mappingStatuses.has(row.mappingStatus)) invalid("broad mapping status");
    if (!validStoredCount(row.visitorCount) || !validStoredCount(row.provinceVisitorCount)) invalid("broad visitor count");
    if (!validStoredPercent(row.provinceNationalSharePct) || !validStoredPercent(row.nationalSharePct)) invalid("broad visitor share");
    if (row.localWithinProvinceSharePct !== null || row.sourceLocalName !== null) invalid("broad grain");
  }

  const localSeen = new Set();
  for (const row of snapshot.localRegions) {
    const identity = `${row?.sourceProvinceName || ""}\u0000${row?.sourceLocalName || ""}`;
    if (!row || !String(row.sourceProvinceName || "").trim() || !String(row.sourceLocalName || "").trim() || localSeen.has(identity)) invalid("local source identity");
    localSeen.add(identity);
    if (!mappingStatuses.has(row.mappingStatus)) invalid("local mapping status");
    if (!validStoredCount(row.visitorCount) || !validStoredCount(row.provinceVisitorCount)) invalid("local visitor count");
    if (!validStoredPercent(row.provinceNationalSharePct) || !validStoredPercent(row.localWithinProvinceSharePct)) invalid("local visitor share");
    if (row.mappingStatus === "unalignable" && row.currentRegionKey) invalid("unalignable current region");
  }

  const expectedMonths = Array.from({ length: 12 }, (_, index) => shiftYearMonth(period.startYearMonth, index));
  for (let index = 0; index < snapshot.nationalMonthlyTrend.length; index += 1) {
    const row = snapshot.nationalMonthlyTrend[index];
    if (row?.yearMonth !== expectedMonths[index] || row.sourceProvinceName !== "전국") invalid("national trend period");
    if (!validStoredCount(row.residentVisitors) || !validStoredCount(row.nonResidentVisitors) || !validStoredCount(row.totalVisitors)) invalid("national trend counts");
    if (Math.abs(row.totalVisitors - row.residentVisitors - row.nonResidentVisitors) > 1) invalid("national trend identity");
  }
  if (
    snapshot.quality?.status !== "complete"
    || snapshot.quality.broadRegionCount !== snapshot.broadRegions.length
    || snapshot.quality.localRegionCount !== snapshot.localRegions.length
    || snapshot.quality.trendMonthCount !== snapshot.nationalMonthlyTrend.length
  ) invalid("quality counters");
  return snapshot;
}

async function readBoundedJson(filePath, maxBytes) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) fail("invalid_snapshot", "Period summary file is invalid or too large.", { filePath });
  let parsed;
  try {
    parsed = JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    fail("invalid_snapshot", "Period summary file is not valid JSON.", { filePath, message: error.message });
  }
  return assertStoredSnapshotShape(parsed, filePath);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeNewFileAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let tempCreated = false;
  try {
    const handle = await fsp.open(tempPath, "wx", 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A hard link publishes the fully-written inode only if the destination does not yet exist.
    await fsp.link(tempPath, filePath);
    return true;
  } finally {
    if (tempCreated) await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

function normalizeRegionRequest(input) {
  if (typeof input === "string") return { regionKey: input };
  if (!input || typeof input !== "object") return { regionKey: "" };
  return input;
}

function publicRegion(unit, regionKey) {
  return {
    regionKey,
    name: unit?.name || unit?.fullName || "",
    fullName: unit?.fullName || unit?.name || "",
    level: unit?.level || ""
  };
}

function joinedSourceNames(rows, field) {
  return [...new Set(rows.map((row) => row[field]).filter(Boolean))].sort().join(" + ") || null;
}

function summarizeRegionRows(snapshot, rows) {
  const mappingStatuses = [...new Set(rows.map((row) => row.mappingStatus).filter(Boolean))];
  const isBroad = rows.every((row) => !row.sourceLocalName);
  const multiple = rows.length > 1;
  const visitorCounts = rows.map((row) => row.visitorCount);
  const broadProvinceCounts = rows.map((row) => row.provinceVisitorCount ?? row.visitorCount);
  const visitorCount = visitorCounts.every(validStoredCount)
    ? visitorCounts.reduce((sum, value) => sum + value, 0)
    : null;
  return {
    period: {
      startYearMonth: snapshot.period.startYearMonth,
      endYearMonth: snapshot.period.endYearMonth,
      monthCount: snapshot.period.monthCount
    },
    visitorCount,
    provinceVisitorCount: isBroad
      ? broadProvinceCounts.every(validStoredCount)
        ? broadProvinceCounts.reduce((sum, value) => sum + value, 0)
        : null
      : multiple
        ? null
        : rows[0].provinceVisitorCount,
    provinceNationalSharePct: roundNumber(
      isBroad
        ? rows.reduce((sum, row) => sum + Number(row.provinceNationalSharePct ?? row.nationalSharePct ?? 0), 0)
        : multiple
          ? NaN
          : Number(rows[0].provinceNationalSharePct),
      4
    ),
    localWithinProvinceSharePct: isBroad || multiple
      ? null
      : roundNumber(rows[0].localWithinProvinceSharePct, 4),
    sourceProvinceName: joinedSourceNames(rows, "sourceProvinceName"),
    sourceLocalName: joinedSourceNames(rows, "sourceLocalName"),
    mappingStatus: mappingStatuses.length === 1 ? mappingStatuses[0] : "unalignable",
    collectedAt: snapshot.collectedAt
  };
}

function comparePeriodRows(previous, latest) {
  if (!previous || !latest) return { status: "insufficient_data", changeRate: null, changePercent: null };
  if (previous.period.endYearMonth >= latest.period.startYearMonth) {
    return { status: "overlapping_periods", changeRate: null, changePercent: null };
  }
  if (shiftYearMonth(previous.period.endYearMonth, 1) !== latest.period.startYearMonth) {
    return { status: "non_consecutive_periods", changeRate: null, changePercent: null };
  }
  if (
    previous.sourceProvinceName !== latest.sourceProvinceName
    || previous.sourceLocalName !== latest.sourceLocalName
    || previous.mappingStatus !== latest.mappingStatus
  ) {
    return { status: "not_comparable", changeRate: null, changePercent: null };
  }
  if (!Number.isFinite(previous.visitorCount) || !Number.isFinite(latest.visitorCount)) {
    return { status: "insufficient_data", changeRate: null, changePercent: null };
  }
  if (previous.visitorCount === 0) return { status: "previous_zero", changeRate: null, changePercent: null };
  const changeRate = (latest.visitorCount - previous.visitorCount) / previous.visitorCount;
  return {
    status: "ready",
    changeRate: roundNumber(changeRate, 6),
    changePercent: roundNumber(changeRate * 100, 2)
  };
}

function createPeriodSummaryImporter(options = {}) {
  const tourismDataDir = path.resolve(String(
    options.tourismDataDir
    || process.env.TOURISM_DATA_DIR
    || path.join(process.env.DATA_DIR || ROOT, "tourism_data")
  ));
  const summaryDir = path.join(tourismDataDir, "period_summaries");
  const regionMasterFile = path.resolve(String(options.regionMasterFile || path.join(ROOT, "web", "data", "region_master.json")));
  const limits = mergeLimits(options.limits || {});
  const now = typeof options.now === "function" ? options.now : () => new Date();
  let resolverPromise = null;

  async function regionResolver() {
    if (!resolverPromise) {
      resolverPromise = readJsonFile(regionMasterFile, "invalid_region_master").then(buildRegionResolver);
    }
    return resolverPromise;
  }

  function summaryPath(startYearMonth, endYearMonth) {
    return path.join(summaryDir, summaryFileName(startYearMonth, endYearMonth));
  }

  async function inspectArchive({ filePath } = {}) {
    if (!filePath) fail("missing_archive", "filePath is required.");
    const archiveInfo = parseArchiveFileName(filePath);
    const resolved = path.resolve(String(filePath));
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      fail("archive_not_found", "ZIP archive was not found.", { filePath: resolved });
    }
    if (!stat.isFile()) fail("invalid_archive", "ZIP archive path must point to a file.");
    if (stat.size > limits.maxArchiveBytes) fail("archive_too_large", "ZIP archive exceeds the configured size limit.");
    const archive = await fsp.readFile(resolved);
    const entries = readSafeZipBuffer(archive, limits);
    const entriesByKind = identifyRequiredEntries(entries, archiveInfo.timestamp);
    const normalized = normalizeOfficialCsvs(entriesByKind);
    const resolver = await regionResolver();
    const current = now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) fail("invalid_clock", "now() must return a valid Date.");
    return buildSnapshot({
      archiveInfo,
      archiveSha256: sha256(archive),
      entriesByKind,
      normalized,
      resolver,
      collectedAt: current.toISOString()
    });
  }

  async function importArchive({ filePath, apply = false } = {}) {
    const snapshot = await inspectArchive({ filePath });
    const filePathOut = summaryPath(snapshot.period.startYearMonth, snapshot.period.endYearMonth);
    if (!apply) {
      return {
        ok: true,
        status: "dry_run",
        reason: "apply_not_requested",
        applied: false,
        filePath: null,
        targetFilePath: filePathOut,
        snapshot
      };
    }
    if (snapshot.quality?.status !== "complete") fail("quality_gate_failed", "Period summary did not pass the quality gate.");

    if (await pathExists(filePathOut)) {
      const existing = await readBoundedJson(filePathOut, limits.maxSnapshotBytes);
      if (existing.source?.archiveSha256 === snapshot.source.archiveSha256) {
        return {
          ok: true,
          status: "unchanged",
          reason: "same_archive_already_imported",
          applied: false,
          filePath: filePathOut,
          targetFilePath: filePathOut,
          snapshot: existing
        };
      }
      fail("snapshot_conflict", "A different archive is already stored for this period.", { filePath: filePathOut });
    }

    try {
      await writeNewFileAtomically(filePathOut, `${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readBoundedJson(filePathOut, limits.maxSnapshotBytes);
      if (existing.source?.archiveSha256 === snapshot.source.archiveSha256) {
        return {
          ok: true,
          status: "unchanged",
          reason: "same_archive_already_imported",
          applied: false,
          filePath: filePathOut,
          targetFilePath: filePathOut,
          snapshot: existing
        };
      }
      fail("snapshot_conflict", "A different archive won the atomic write for this period.", { filePath: filePathOut });
    }
    return {
      ok: true,
      status: "applied",
      reason: "",
      applied: true,
      filePath: filePathOut,
      targetFilePath: filePathOut,
      snapshot
    };
  }

  async function readSummary({ startYearMonth, endYearMonth } = {}) {
    const filePath = summaryPath(startYearMonth, endYearMonth);
    try {
      return { hit: true, filePath, data: await readBoundedJson(filePath, limits.maxSnapshotBytes) };
    } catch (error) {
      if (error.code === "ENOENT") return { hit: false, filePath, data: null };
      throw error;
    }
  }

  async function listStoredSummaries() {
    let names;
    try {
      names = await fsp.readdir(summaryDir);
    } catch (error) {
      if (error.code === "ENOENT") return { summaries: [], invalidFiles: [] };
      throw error;
    }
    const pattern = new RegExp(`^${ADAPTER_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}__(\\d{6})__(\\d{6})\\.json$`);
    const summaries = [];
    const invalidFiles = [];
    for (const name of names.sort()) {
      const match = pattern.exec(name);
      if (!match) continue;
      const filePath = path.join(summaryDir, name);
      try {
        const data = await readBoundedJson(filePath, limits.maxSnapshotBytes);
        if (data.period.startYearMonth !== match[1] || data.period.endYearMonth !== match[2]) {
          fail("invalid_snapshot", "Snapshot period does not match its file name.", { filePath });
        }
        summaries.push({ filePath, data });
      } catch (error) {
        invalidFiles.push({ filePath, code: error.code || "invalid_snapshot" });
      }
    }
    summaries.sort((left, right) => (
      left.data.period.endYearMonth.localeCompare(right.data.period.endYearMonth)
      || left.data.period.startYearMonth.localeCompare(right.data.period.startYearMonth)
    ));
    return { summaries, invalidFiles };
  }

  async function latestSummary() {
    const { summaries } = await listStoredSummaries();
    const latest = summaries.at(-1) || null;
    return latest
      ? { hit: true, filePath: latest.filePath, data: latest.data }
      : { hit: false, filePath: null, data: null };
  }

  async function periodSummaryForRegion(input = {}) {
    const request = normalizeRegionRequest(input);
    const regionKey = String(request.regionKey || "").trim();
    if (!regionKey) fail("missing_region_key", "regionKey is required.");
    const resolver = await regionResolver();
    const unit = resolver.byRegionKey(regionKey);
    const { summaries } = await listStoredSummaries();
    const filtered = summaries.filter(({ data }) => {
      if (request.startYearMonth && data.period.endYearMonth < strictYearMonth(request.startYearMonth, "startYearMonth")) return false;
      if (request.endYearMonth && data.period.endYearMonth > strictYearMonth(request.endYearMonth, "endYearMonth")) return false;
      return true;
    });

    const snapshots = [];
    for (const { data } of filtered) {
      const matches = (rows) => rows.filter((row) => (
        row.currentRegionKey === regionKey
        || (!row.currentRegionKey && row.historicalRegionKey === regionKey)
      ));
      const localCandidates = matches(data.localRegions);
      const candidates = localCandidates.length ? localCandidates : matches(data.broadRegions);
      if (candidates.length) snapshots.push(summarizeRegionRows(data, candidates));
    }
    const latest = snapshots.at(-1) || null;
    const previous = snapshots.at(-2) || null;
    const comparison = comparePeriodRows(previous, latest);
    const region = publicRegion(unit, regionKey);
    if (!latest) {
      return {
        ok: false,
        status: "unavailable",
        reason: "period_summary_not_found",
        region,
        snapshots: [],
        latest: null,
        previous: null,
        comparison,
        source: { label: SOURCE_LABEL },
        policy: { ...POLICY }
      };
    }
    return {
      ok: true,
      status: "ok",
      reason: "",
      region,
      snapshots,
      latest,
      previous,
      comparison,
      source: { label: SOURCE_LABEL },
      policy: { ...POLICY }
    };
  }

  async function status() {
    const { summaries, invalidFiles } = await listStoredSummaries();
    const latest = summaries.at(-1) || null;
    return {
      ok: invalidFiles.length === 0,
      status: invalidFiles.length ? "degraded" : summaries.length ? "ready" : "empty",
      adapter: ADAPTER_VERSION,
      directory: summaryDir,
      summaryCount: summaries.length,
      snapshotCount: summaries.length,
      periods: summaries.map(({ data }) => ({ ...data.period, collectedAt: data.collectedAt })),
      latest: latest ? {
        filePath: latest.filePath,
        period: { ...latest.data.period },
        collectedAt: latest.data.collectedAt,
        source: { label: latest.data.source.label }
      } : null,
      invalidFileCount: invalidFiles.length,
      invalidFiles,
      policy: { ...POLICY }
    };
  }

  return {
    inspectArchive,
    importArchive,
    readSummary,
    latestSummary,
    periodSummaryForRegion,
    summaryForRegion: periodSummaryForRegion,
    status
  };
}

module.exports = {
  ADAPTER_VERSION,
  SCHEMA_VERSION,
  SOURCE_LABEL,
  POLICY,
  DEFAULT_LIMITS,
  PeriodSummaryError,
  createPeriodSummaryImporter,
  readSafeZip,
  readSafeZipBuffer,
  parseArchiveFileName,
  parseCsv,
  crc32
};
