"use strict";

// Offline preparation only. This module does not request an API or change source files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { normalizeDataset } = require("./lib/regional_catchment.cjs");

const METRICS = ["population", "establishments", "workers"];
const MAX_CELLS = 50000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const KOREA_BOUNDS = [123, 32, 133, 40];

function fail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("PREPARE_INVALID_MAPPING", `${label} must be an object`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) fail("PREPARE_INVALID_MAPPING", `${label} is required`); return value.trim(); }
function ownKeys(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("PREPARE_UNKNOWN_FIELD", `${label}.${key}`); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function decodeUTF8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { fail("PREPARE_NOT_UTF8", `${label} must be valid UTF-8; convert a separate copy and retain the original`); }
}
function parseJSON(bytes, label) { try { return JSON.parse(decodeUTF8(bytes, label)); } catch (error) { if (error.code) throw error; fail("PREPARE_INVALID_JSON", label); } }

function decodeCSV(bytes, encoding = "utf-8") {
  if (encoding === "utf-8") return { sourceEncoding: "utf8", text: decodeUTF8(bytes, "CSV") };
  if (encoding !== "euc-kr") fail("PREPARE_INVALID_MAPPING", "csv.encoding must be utf-8 or euc-kr (CP949)");
  let cptable;
  try { cptable = require("xlsx/dist/cpexcel.js"); }
  catch { fail("PREPARE_CP949_DECODER_UNAVAILABLE", "Install the repository's existing xlsx dependency before reading CP949; no fallback decoder is used"); }
  // Node/ICU TextDecoder('euc-kr') can silently misdecode CP949 extensions.
  // Reuse the full codepage table already shipped with xlsx and reject lossy decoding.
  let decoded, roundtrip;
  try { decoded = cptable.utils.decode(949, bytes); roundtrip = Buffer.from(cptable.utils.encode(949, decoded)); }
  catch { fail("PREPARE_INVALID_CP949", "CSV could not be decoded losslessly as CP949"); }
  if (!roundtrip.equals(bytes) || /[\u0000\uFFFD]/.test(decoded)) fail("PREPARE_INVALID_CP949", "CSV contains invalid or non-roundtrippable CP949 bytes");
  return { sourceEncoding: "cp949", text: decoded };
}

function parseCSV(input, delimiter = ",", options = {}) {
  if (typeof delimiter !== "string" || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) fail("PREPARE_INVALID_MAPPING", "csv.delimiter must be one character");
  const source = input.replace(/^\uFEFF/, "");
  const rows = [], row = [];
  let value = "", quoted = false, closed = false, fieldStarted = false;
  function finishField() { row.push(value); value = ""; closed = false; fieldStarted = false; }
  function finishRow() { finishField(); rows.push(row.splice(0)); }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { value += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else value += char;
      continue;
    }
    if (closed && char !== delimiter && char !== "\r" && char !== "\n") fail("PREPARE_INVALID_CSV", "Unexpected character after a quoted field");
    if (char === '"') {
      if (fieldStarted || value) fail("PREPARE_INVALID_CSV", "Quote inside an unquoted field");
      quoted = true; fieldStarted = true;
    } else if (char === delimiter) finishField();
    else if (char === "\r" || char === "\n") {
      finishRow(); if (char === "\r" && source[index + 1] === "\n") index += 1;
    } else { value += char; fieldStarted = true; }
  }
  if (quoted) fail("PREPARE_INVALID_CSV", "Unterminated quoted field");
  if (value !== "" || row.length || fieldStarted || closed) finishRow();
  if (!rows.length) fail("PREPARE_INVALID_CSV", "CSV is empty");
  const hasHeader = options.header !== false;
  const headers = hasHeader ? rows.shift() : options.columns;
  if (!Array.isArray(headers) || !headers.length || headers.some(header => typeof header !== "string" || !header)) fail("PREPARE_INVALID_CSV", "Headerless CSV requires explicit non-empty column names");
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) fail("PREPARE_INVALID_CSV", "Blank or duplicate headers");
  const records = rows.map((fields, index) => {
    if (fields.length !== headers.length) fail("PREPARE_INVALID_CSV", `Record ${index + (hasHeader ? 2 : 1)} has ${fields.length} fields; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, column) => [header, fields[column]]));
  });
  return { headers, records };
}

function coordinate(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "number" || !Number.isFinite(value))) fail("PREPARE_INVALID_COORDINATE", "Coordinates must be finite [longitude, latitude] numbers");
  const [longitude, latitude] = pair;
  if (longitude < KOREA_BOUNDS[0] || longitude > KOREA_BOUNDS[2] || latitude < KOREA_BOUNDS[1] || latitude > KOREA_BOUNDS[3]) fail("PREPARE_INVALID_COORDINATE", "Expected Korean WGS84 longitude/latitude; projected or reversed coordinates are not accepted");
  return [longitude, latitude];
}
function samePoint(left, right) { return left[0] === right[0] && left[1] === right[1]; }
function gridCenter(geometry, pointRole) {
  object(geometry, "feature.geometry");
  if (geometry.type === "Point") {
    if (pointRole !== "grid_centroid") fail("PREPARE_AMBIGUOUS_POINT", "Point geometry requires geometry.pointRole=grid_centroid");
    return coordinate(geometry.coordinates);
  }
  if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) fail("PREPARE_COMPLEX_GEOMETRY", "Only grid-centroid Points or a single-ring grid Polygon are supported");
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length !== 5) fail("PREPARE_COMPLEX_GEOMETRY", "A grid polygon must have four distinct corners and a closing coordinate");
  ring.forEach(coordinate);
  if (!samePoint(ring[0], ring[4])) fail("PREPARE_COMPLEX_GEOMETRY", "Grid polygon must be closed");
  const points = ring.slice(0, 4);
  if (new Set(points.map(pair => pair.join(","))).size !== 4) fail("PREPARE_COMPLEX_GEOMETRY", "Grid corners must be distinct");
  const orientation = [];
  for (let index = 0; index < 4; index += 1) {
    const a = points[index], b = points[(index + 1) % 4], c = points[(index + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-14) fail("PREPARE_COMPLEX_GEOMETRY", "Degenerate grid polygon");
    orientation.push(Math.sign(cross));
  }
  if (new Set(orientation).size !== 1) fail("PREPARE_COMPLEX_GEOMETRY", "Concave or self-intersecting grid polygon");
  // Translate to the first corner to avoid cancellation of large lon/lat products.
  const origin = points[0], shifted = points.map(([x, y]) => [x - origin[0], y - origin[1]]);
  let twiceArea = 0, cx = 0, cy = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = shifted[index], b = shifted[(index + 1) % 4], cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross; cx += (a[0] + b[0]) * cross; cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-14) fail("PREPARE_COMPLEX_GEOMETRY", "Zero-area grid polygon");
  return coordinate([origin[0] + cx / (3 * twiceArea), origin[1] + cy / (3 * twiceArea)]);
}

function validateMapping(mapping) {
  object(mapping, "mapping");
  ownKeys(mapping, ["version", "dataset", "geometry", "csv"], "mapping");
  if (mapping.version !== "catchment-grid-mapping-v1") fail("PREPARE_INVALID_MAPPING", "version must be catchment-grid-mapping-v1");
  const dataset = object(mapping.dataset, "dataset"), geometry = object(mapping.geometry, "geometry"), csv = object(mapping.csv, "csv");
  ownKeys(dataset, ["id", "provider", "sourceUrl", "sourceYear", "boundaryYear", "gridSizeM", "industryClassification", "coverageBBox", "completeFrame", "sourceTransform"], "dataset");
  for (const name of ["id", "provider", "sourceUrl"]) text(dataset[name], `dataset.${name}`);
  if (!/^https:\/\//.test(dataset.sourceUrl)) fail("PREPARE_INVALID_MAPPING", "dataset.sourceUrl must be HTTPS");
  if (!/SGIS/i.test(dataset.provider)) fail("PREPARE_INVALID_MAPPING", "This source adapter only supports SGIS; another provider requires its own disclosure rules");
  for (const name of ["sourceYear", "boundaryYear"]) if (!Number.isInteger(dataset[name]) || dataset[name] < 1900 || dataset[name] > 2100) fail("PREPARE_INVALID_MAPPING", `dataset.${name} must be a four-digit integer`);
  if (![100, 250, 500, 1000].includes(dataset.gridSizeM)) fail("PREPARE_INVALID_MAPPING", "gridSizeM must be 100, 250, 500 or 1000");
  if (dataset.completeFrame !== undefined && typeof dataset.completeFrame !== "boolean") fail("PREPARE_INVALID_MAPPING", "completeFrame must be boolean");
  if (dataset.completeFrame === true && !dataset.coverageBBox) fail("PREPARE_INVALID_MAPPING", "A complete frame requires an explicit coverageBBox declaration");
  if (dataset.sourceTransform !== undefined && !["none", "utf8_conversion"].includes(dataset.sourceTransform)) fail("PREPARE_INVALID_MAPPING", "sourceTransform must be none or utf8_conversion");
  text(dataset.industryClassification, "dataset.industryClassification");
  ownKeys(geometry, ["gridIdField", "crs", "pointRole"], "geometry");
  text(geometry.gridIdField, "geometry.gridIdField");
  if (geometry.crs !== "EPSG:4326") fail("PREPARE_INVALID_CRS", "Reproject a separate copy to EPSG:4326 before preparation; changing its label is not a conversion");
  if (geometry.pointRole !== undefined && geometry.pointRole !== "grid_centroid") fail("PREPARE_INVALID_MAPPING", "pointRole must be grid_centroid");
  ownKeys(csv, ["format", "idColumn", "yearColumn", "metricColumn", "valueColumn", "metricCodes", "metricColumns", "delimiter", "encoding", "header", "columns"], "csv");
  if (csv.encoding !== undefined && !["utf-8", "euc-kr"].includes(csv.encoding)) fail("PREPARE_INVALID_MAPPING", "csv.encoding must be utf-8 or euc-kr (CP949)");
  if (csv.header !== undefined && typeof csv.header !== "boolean") fail("PREPARE_INVALID_MAPPING", "csv.header must be boolean");
  if (csv.header === false) {
    if (!Array.isArray(csv.columns) || !csv.columns.length || csv.columns.some(column => typeof column !== "string" || !column.trim()) || new Set(csv.columns).size !== csv.columns.length) fail("PREPARE_INVALID_MAPPING", "header:false requires distinct, explicitly ordered csv.columns");
  } else if (csv.columns !== undefined) fail("PREPARE_INVALID_MAPPING", "csv.columns is only valid with header:false");
  if (csv.encoding === "euc-kr" && dataset.sourceTransform === "utf8_conversion") fail("PREPARE_INVALID_MAPPING", "CP949 original input must not be labelled as an existing UTF-8 conversion");
  text(csv.idColumn, "csv.idColumn"); text(csv.yearColumn, "csv.yearColumn");
  if (!["long", "wide"].includes(csv.format)) fail("PREPARE_INVALID_MAPPING", "csv.format must be long or wide");
  const columnNames = [csv.idColumn, csv.yearColumn];
  if (csv.format === "long") {
    text(csv.metricColumn, "csv.metricColumn"); text(csv.valueColumn, "csv.valueColumn");
    ownKeys(object(csv.metricCodes, "csv.metricCodes"), METRICS, "csv.metricCodes");
    const codes = Object.keys(csv.metricCodes).map(metric => text(csv.metricCodes[metric], `csv.metricCodes.${metric}`));
    if (!codes.length || new Set(codes).size !== codes.length) fail("PREPARE_INVALID_MAPPING", "At least one explicit metric code is required and each code must be distinct");
    columnNames.push(csv.metricColumn, csv.valueColumn);
    if (csv.metricColumns !== undefined) fail("PREPARE_INVALID_MAPPING", "metricColumns is only valid for wide CSV");
  } else {
    ownKeys(object(csv.metricColumns, "csv.metricColumns"), METRICS, "csv.metricColumns");
    const selectedMetrics = Object.keys(csv.metricColumns);
    if (!selectedMetrics.length) fail("PREPARE_INVALID_MAPPING", "At least one explicit metric column is required");
    selectedMetrics.forEach(metric => columnNames.push(text(csv.metricColumns[metric], `csv.metricColumns.${metric}`)));
    for (const name of ["metricColumn", "valueColumn", "metricCodes"]) if (csv[name] !== undefined) fail("PREPARE_INVALID_MAPPING", `${name} is only valid for long CSV`);
  }
  if (new Set(columnNames).size !== columnNames.length) fail("PREPARE_INVALID_MAPPING", "Mapped CSV columns must be distinct");
  return mapping;
}

function parseValue(raw, rowNumber, metric) {
  const value = raw.trim();
  if (!value) return { status: "not_acquired", value: null };
  if (value === "N/A") return { status: "suppressed", value: null };
  if (!/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value)) fail("PREPARE_INVALID_VALUE", `Row ${rowNumber}, ${metric}: expected a non-negative integer, N/A or empty`);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) fail("PREPARE_INVALID_VALUE", `Row ${rowNumber}, ${metric}: value is not a safe integer`);
  return { status: numeric === 0 ? "protected_zero" : "observed_public", value: numeric };
}

function prepareDataset({ csvBytes, geojsonBytes, mappingBytes, boundarySourceBytes }) {
  for (const [label, bytes] of Object.entries({ csvBytes, geojsonBytes, mappingBytes, boundarySourceBytes })) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail("PREPARE_MISSING_INPUT", `${label} is required`);
    if (bytes.length > MAX_INPUT_BYTES) fail("PREPARE_INPUT_TOO_LARGE", `${label} exceeds 128 MiB`);
  }
  const mapping = validateMapping(parseJSON(mappingBytes, "mapping"));
  const geojson = object(parseJSON(geojsonBytes, "GeoJSON"), "GeoJSON");
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) fail("PREPARE_INVALID_GEOJSON", "A non-empty FeatureCollection is required");
  if (geojson.features.length > MAX_CELLS) fail("PREPARE_TOO_MANY_CELLS", "At most 50,000 cells are accepted per bundle");
  if (geojson.crs && !["EPSG:4326", "urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:EPSG::4326"].includes(geojson.crs.properties?.name)) fail("PREPARE_INVALID_CRS", "GeoJSON declares a non-WGS84 CRS");
  const cellsById = new Map();
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const feature of geojson.features) {
    if (!feature || feature.type !== "Feature") fail("PREPARE_INVALID_GEOJSON", "Every item must be a Feature");
    const id = text(feature.properties?.[mapping.geometry.gridIdField], "GeoJSON grid id");
    if (cellsById.has(id)) fail("PREPARE_DUPLICATE_GRID", `Duplicate GeoJSON grid: ${id}`);
    const [longitude, latitude] = gridCenter(feature.geometry, mapping.geometry.pointRole);
    minLon = Math.min(minLon, longitude); maxLon = Math.max(maxLon, longitude); minLat = Math.min(minLat, latitude); maxLat = Math.max(maxLat, latitude);
    const cell = { id, latitude, longitude };
    for (const metric of METRICS) cell[metric] = { status: "not_acquired", value: null };
    cellsById.set(id, cell);
  }
  const decodedCSV = decodeCSV(csvBytes, mapping.csv.encoding);
  const csv = parseCSV(decodedCSV.text, mapping.csv.delimiter, { header: mapping.csv.header, columns: mapping.csv.columns });
  const requiredColumns = [mapping.csv.idColumn, mapping.csv.yearColumn, ...(mapping.csv.format === "long" ? [mapping.csv.metricColumn, mapping.csv.valueColumn] : Object.values(mapping.csv.metricColumns))];
  for (const column of requiredColumns) if (!csv.headers.includes(column)) fail("PREPARE_MISSING_COLUMN", `CSV column not found: ${column}`);
  if (!csv.records.length) fail("PREPARE_INVALID_CSV", "CSV contains no statistic rows");
  const seen = new Set(), codes = mapping.csv.format === "long" ? new Map(Object.keys(mapping.csv.metricCodes).map(metric => [mapping.csv.metricCodes[metric].trim(), metric])) : null;
  let selectedRows = 0, unselectedRows = 0;
  csv.records.forEach((record, index) => {
    const rowNumber = index + (mapping.csv.header === false ? 1 : 2), id = record[mapping.csv.idColumn].trim();
    if (!id || !cellsById.has(id)) fail("PREPARE_UNMATCHED_GRID", `Row ${rowNumber}: statistic grid has no geometry: ${id || "(empty)"}`);
    const year = record[mapping.csv.yearColumn].trim();
    if (year !== String(mapping.dataset.sourceYear)) fail("PREPARE_MIXED_YEAR", `Row ${rowNumber}: year ${year || "(empty)"} differs from ${mapping.dataset.sourceYear}`);
    const cell = cellsById.get(id);
    function assign(metric, raw) {
      const key = `${id}\u0000${metric}`;
      if (seen.has(key)) fail("PREPARE_DUPLICATE_STATISTIC", `Row ${rowNumber}: duplicate ${id}/${metric}`);
      seen.add(key); cell[metric] = parseValue(raw, rowNumber, metric);
    }
    if (mapping.csv.format === "long") {
      const metric = codes.get(record[mapping.csv.metricColumn].trim());
      if (!metric) { unselectedRows += 1; return; }
      assign(metric, record[mapping.csv.valueColumn]); selectedRows += 1;
    } else { Object.keys(mapping.csv.metricColumns).forEach(metric => assign(metric, record[mapping.csv.metricColumns[metric]])); selectedRows += 1; }
  });
  if (!selectedRows) fail("PREPARE_NO_SELECTED_METRICS", "No CSV row matches the explicitly mapped metric codes");
  const coverageBBox = mapping.dataset.coverageBBox || [minLon, minLat, maxLon, maxLat];
  if (!Array.isArray(coverageBBox) || coverageBBox.length !== 4) fail("PREPARE_INVALID_COVERAGE", "coverageBBox must be [minLon,minLat,maxLon,maxLat]");
  coordinate(coverageBBox.slice(0, 2)); coordinate(coverageBBox.slice(2));
  if (coverageBBox[0] >= coverageBBox[2] || coverageBBox[1] >= coverageBBox[3]) fail("PREPARE_INVALID_COVERAGE", "coverageBBox must have positive width and height; declare the source frame explicitly for a single row or column");
  if (minLon < coverageBBox[0] || minLat < coverageBBox[1] || maxLon > coverageBBox[2] || maxLat > coverageBBox[3]) fail("PREPARE_INVALID_COVERAGE", "A grid centroid lies outside the declared coverageBBox");
  const candidate = {
    id: mapping.dataset.id.trim(), provider: mapping.dataset.provider.trim(), sourceUrl: mapping.dataset.sourceUrl.trim(),
    sourceYear: mapping.dataset.sourceYear, boundaryYear: mapping.dataset.boundaryYear, gridSizeM: mapping.dataset.gridSizeM,
    crs: "EPSG:4326", sourceSha256: sha256(csvBytes), boundarySha256: sha256(boundarySourceBytes),
    derivedGeometrySha256: sha256(geojsonBytes), mappingSha256: sha256(mappingBytes), derivedCsvSha256: sha256(Buffer.from(decodedCSV.text, "utf8")), sourceEncoding: decodedCSV.sourceEncoding,
    boundaryHashKind: "original_file", sourceHashKind: "input_csv", sourceTransform: mapping.dataset.sourceTransform || "none",
    industryClassification: mapping.dataset.industryClassification.trim(), coverageBBox, completeFrame: mapping.dataset.completeFrame === true,
    units: { population: "명", establishments: "개", workers: "명" },
    disclosureMethod: "SGIS published privacy-protected statistics; zero is protected_zero; N/A is suppressed",
    cells: [...cellsById.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
  };
  // The same validator used at server import also validates offline preparation.
  // Its fingerprint belongs to the server's internal representation, not the import schema.
  const { fingerprint, ...dataset } = normalizeDataset(candidate);
  const json = JSON.stringify(dataset) + "\n";
  if (Buffer.byteLength(json) > MAX_OUTPUT_BYTES) fail("PREPARE_OUTPUT_TOO_LARGE", "Prepared bundle exceeds 8 MiB; split it into source frames without claiming complete coverage");
  return { dataset, json, summary: { cells: dataset.cells.length, statisticRows: csv.records.length, selectedRows, unselectedRows, outputBytes: Buffer.byteLength(json), sourceSha256: dataset.sourceSha256, sourceEncoding: dataset.sourceEncoding, derivedCsvSha256: dataset.derivedCsvSha256, boundarySha256: dataset.boundarySha256, derivedGeometrySha256: dataset.derivedGeometrySha256, completeFrame: dataset.completeFrame, coverageDeclared: Boolean(mapping.dataset.coverageBBox) } };
}

function parseArgs(argv) {
  const names = { "--csv": "csv", "--geojson": "geojson", "--mapping": "mapping", "--boundary-source": "boundarySource", "--out": "out" };
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") { if (argv.length !== 1) fail("PREPARE_ARGUMENT", "--help cannot be combined with input flags"); return { help: true }; }
    if (!names[flag]) fail("PREPARE_ARGUMENT", `Unknown argument: ${flag}`);
    if (args[names[flag]]) fail("PREPARE_ARGUMENT", `Repeated argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("PREPARE_ARGUMENT", `Missing value for ${flag}`);
    args[names[flag]] = path.resolve(value);
  }
  for (const name of Object.values(names)) if (!args[name]) fail("PREPARE_ARGUMENT", `Missing ${Object.keys(names).find(flag => names[flag] === name)}`);
  if (new Set(Object.values(args)).size !== Object.values(args).length) fail("PREPARE_ARGUMENT", "Input and output paths must be distinct");
  return args;
}
function readBounded(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) fail("PREPARE_INPUT_TOO_LARGE", `${path.basename(file)} must be a file of at most 128 MiB`);
  return fs.readFileSync(file);
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write("Offline SGIS grid preparation\nnode scripts/prepare_catchment_grid.cjs --csv statistics-utf8.csv --geojson grids-wgs84.geojson --mapping mapping.json --boundary-source original-boundaries.zip --out prepared.json\nSee docs/regional-catchment-sources.md for the explicit mapping contract. No network requests; no source modifications; output never overwritten.\n"); return; }
  const result = prepareDataset({ csvBytes: readBounded(args.csv), geojsonBytes: readBounded(args.geojson), mappingBytes: readBounded(args.mapping), boundarySourceBytes: readBounded(args.boundarySource) });
  // wx makes a lost response or an accidental rerun safe: inspect the existing file instead of overwriting it.
  fs.writeFileSync(args.out, result.json, { encoding: "utf8", flag: "wx" });
  process.stdout.write(JSON.stringify({ output: args.out, ...result.summary }) + "\n");
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { parseCSV, decodeCSV, gridCenter, validateMapping, prepareDataset, parseArgs, main, MAX_CELLS, MAX_OUTPUT_BYTES };
