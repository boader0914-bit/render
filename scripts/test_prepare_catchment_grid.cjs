"use strict";
// Every statistic in this file is a deliberately synthetic fixture, not an SGIS observation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { parseCSV, decodeCSV, gridCenter, prepareDataset, parseArgs, MAX_CELLS, MAX_OUTPUT_BYTES } = require("./prepare_catchment_grid.cjs");
const bytes = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const point = (id, longitude = 127.1, latitude = 36.5) => ({ type: "Feature", properties: { grid_id: id }, geometry: { type: "Point", coordinates: [longitude, latitude] } });
const collection = features => ({ type: "FeatureCollection", features });
const mapping = () => ({ version: "catchment-grid-mapping-v1", dataset: { id: "synthetic-sgis-fixture", provider: "SGIS", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", sourceYear: 2024, boundaryYear: 2025, gridSizeM: 1000, industryClassification: "SYNTHETIC-CLASSIFICATION:all", coverageBBox: [126, 35, 129, 38] }, geometry: { gridIdField: "grid_id", crs: "EPSG:4326", pointRole: "grid_centroid" }, csv: { format: "wide", idColumn: "grid", yearColumn: "year", metricColumns: { population: "people", establishments: "firms", workers: "workers" } } });
function inputs({ csv = "grid,year,people,firms,workers\ngrid-a,2024,10,0,N/A\ngrid-b,2024,,3,9\n", geojson = collection([point("grid-a"), point("grid-b", 127.2, 36.6)]), map = mapping() } = {}) { return { csvBytes: bytes(csv), geojsonBytes: bytes(geojson), mappingBytes: bytes(map), boundarySourceBytes: Buffer.from("SYNTHETIC ORIGINAL BOUNDARY ARCHIVE\0", "utf8") }; }
const expectedCode = (fn, code) => assert.throws(fn, error => error.code === code, `Expected ${code}`);

test("UTF-8 BOM, RFC-style quoting, escaped quotes and embedded newlines are parsed without changing values", () => {
  const parsed = parseCSV('\uFEFFgrid,year,note\r\n"가상-격자",2024,"a,b"\r\n"grid-b",2024,"line1\nline2 and ""quote"""\r\n');
  assert.deepEqual(parsed.headers, ["grid", "year", "note"]);
  assert.deepEqual(parsed.records, [{ grid: "가상-격자", year: "2024", note: "a,b" }, { grid: "grid-b", year: "2024", note: 'line1\nline2 and "quote"' }]);
});

test("malformed CSV, duplicate headers and field counts fail clearly", () => {
  for (const csv of ['a,b\n"broken,b', 'a,b\n"a"x,b', 'a,b\nun"quoted,b', 'a,a\n1,2', 'a,b\n1', 'a,,b\n1,2,3']) expectedCode(() => parseCSV(csv), "PREPARE_INVALID_CSV");
});

test("wide input retains protected zero, N/A, empty and positive values; hashes identify actual different inputs", () => {
  const source = inputs(), before = Object.fromEntries(Object.entries(source).map(([name, value]) => [name, digest(value)]));
  const { dataset, summary, json } = prepareDataset(source), [a, b] = dataset.cells;
  assert.deepEqual(a.population, { status: "observed_public", value: 10 });
  assert.deepEqual(a.establishments, { status: "protected_zero", value: 0 });
  assert.deepEqual(a.workers, { status: "suppressed", value: null });
  assert.deepEqual(b.population, { status: "not_acquired", value: null });
  assert.equal(dataset.sourceSha256, before.csvBytes); assert.equal(dataset.boundarySha256, before.boundarySourceBytes);
  assert.equal(dataset.derivedGeometrySha256, before.geojsonBytes); assert.equal(dataset.mappingSha256, before.mappingBytes);
  assert.notEqual(dataset.boundarySha256, dataset.derivedGeometrySha256);
  assert.equal(dataset.boundaryHashKind, "original_file"); assert.equal(dataset.sourceHashKind, "input_csv");
  assert.equal(dataset.sourceYear, 2024); assert.equal(dataset.boundaryYear, 2025); assert.equal(dataset.completeFrame, false);
  assert.equal("fingerprint" in dataset, false); assert.equal(summary.unselectedRows, 0); assert.equal(json, JSON.stringify(dataset) + "\n");
  for (const [name, value] of Object.entries(source)) assert.equal(digest(value), before[name], name);
});

test("explicit long codes join by grid id and retain missing grid metrics; unused codes are counted", () => {
  const map = mapping(); map.csv = { format: "long", idColumn: "grid", yearColumn: "year", metricColumn: "code", valueColumn: "value", metricCodes: { population: "P_SYNTH", establishments: "B_SYNTH", workers: "W_SYNTH" } };
  const { dataset, summary } = prepareDataset(inputs({ map, csv: "grid,year,code,value\ngrid-b,2024,W_SYNTH,9\ngrid-a,2024,P_SYNTH,10\ngrid-a,2024,UNSELECTED_SYNTH,100\n" }));
  assert.equal(dataset.cells[0].population.value, 10); assert.equal(dataset.cells[1].workers.value, 9);
  assert.deepEqual(dataset.cells[1].establishments, { status: "not_acquired", value: null });
  assert.equal(summary.selectedRows, 2); assert.equal(summary.unselectedRows, 1);
});

test("an official-style Korean grid id is retained rather than converted into an administrative code", () => {
  const result = prepareDataset(inputs({ csv: "grid,year,people,firms,workers\n다사1234,2024,10,1,3\n", geojson: collection([point("다사1234")]) }));
  assert.equal(result.dataset.cells[0].id, "다사1234");
});

test("duplicate geometry, duplicate selected metric and duplicate wide rows do not silently overwrite", () => {
  expectedCode(() => prepareDataset(inputs({ geojson: collection([point("grid-a"), point("grid-a", 127.2)]) })), "PREPARE_DUPLICATE_GRID");
  expectedCode(() => prepareDataset(inputs({ csv: "grid,year,people,firms,workers\ngrid-a,2024,1,2,3\ngrid-a,2024,4,5,6\n" })), "PREPARE_DUPLICATE_STATISTIC");
  const map = mapping(); map.csv = { format: "long", idColumn: "grid", yearColumn: "year", metricColumn: "code", valueColumn: "value", metricCodes: { population: "p", establishments: "b", workers: "w" } };
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid,year,code,value\ngrid-a,2024,p,1\ngrid-a,2024,p,2\n" })), "PREPARE_DUPLICATE_STATISTIC");
});

test("missing geometry, including an unselected-code row, and mixed years fail rather than being dropped", () => {
  expectedCode(() => prepareDataset(inputs({ csv: "grid,year,people,firms,workers\nmissing-grid,2024,1,2,3\n" })), "PREPARE_UNMATCHED_GRID");
  expectedCode(() => prepareDataset(inputs({ csv: "grid,year,people,firms,workers\ngrid-a,2023,1,2,3\n" })), "PREPARE_MIXED_YEAR");
  const map = mapping(); map.csv = { format: "long", idColumn: "grid", yearColumn: "year", metricColumn: "code", valueColumn: "value", metricCodes: { population: "p", establishments: "b", workers: "w" } };
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid,year,code,value\nmissing-grid,2024,unused,1\n" })), "PREPARE_UNMATCHED_GRID");
});

test("a quoted number with commas, NaN, negative, decimals, infinity and unsafe integers require correction", () => {
  for (const value of ['"1,000"', "NaN", "-1", "1.5", "Infinity", "9007199254740992", "-", "null"]) {
    expectedCode(() => prepareDataset(inputs({ csv: `grid,year,people,firms,workers\ngrid-a,2024,${value},2,3\n` })), "PREPARE_INVALID_VALUE");
  }
});

test("EPSG:5179 coordinates, reversed axes, numeric strings, null and out-of-domain points are rejected", () => {
  for (const pair of [[990000, 1800000], [36.5, 127.1], ["127.1", 36.5], [null, 36.5], [120, 36.5]]) {
    expectedCode(() => gridCenter({ type: "Point", coordinates: pair }, "grid_centroid"), "PREPARE_INVALID_COORDINATE");
  }
  const map = mapping(); map.geometry.crs = "EPSG:5179";
  expectedCode(() => prepareDataset(inputs({ map })), "PREPARE_INVALID_CRS");
  const geojson = collection([point("grid-a")]); geojson.crs = { type: "name", properties: { name: "EPSG:5179" } };
  expectedCode(() => prepareDataset(inputs({ geojson })), "PREPARE_INVALID_CRS");
});

test("a simple four-corner grid uses its polygon centroid; an undocumented point is not accepted", () => {
  const geometry = { type: "Polygon", coordinates: [[[127, 36], [127.02, 36], [127.02, 36.01], [127, 36.01], [127, 36]]] };
  const [longitude, latitude] = gridCenter(geometry);
  assert.ok(Math.abs(longitude - 127.01) < 1e-10); assert.ok(Math.abs(latitude - 36.005) < 1e-10);
  expectedCode(() => gridCenter({ type: "Point", coordinates: [127, 36] }), "PREPARE_AMBIGUOUS_POINT");
});

test("holes, multipolygons, concave, self-crossing, unclosed and degenerate grids are rejected", () => {
  const square = [[127, 36], [127.02, 36], [127.02, 36.01], [127, 36.01], [127, 36]];
  for (const geometry of [
    { type: "Polygon", coordinates: [square, square] }, { type: "MultiPolygon", coordinates: [[square]] },
    { type: "Polygon", coordinates: [[[127, 36], [127.02, 36.01], [127.02, 36], [127, 36.01], [127, 36]]] },
    { type: "Polygon", coordinates: [[[127, 36], [127.02, 36], [127.005, 36.001], [127, 36.01], [127, 36]]] },
    { type: "Polygon", coordinates: [square.slice(0, 4)] },
    { type: "Polygon", coordinates: [[[127, 36], [127, 36], [127.02, 36], [127.03, 36], [127, 36]]] }
  ]) expectedCode(() => gridCenter(geometry), "PREPARE_COMPLEX_GEOMETRY");
});

test("explicit code mappings and headers are required, and no matching statistic is an error", () => {
  const map = mapping(); map.csv.metricColumns = {};
  expectedCode(() => prepareDataset(inputs({ map })), "PREPARE_INVALID_MAPPING");
  expectedCode(() => prepareDataset(inputs({ csv: "grid,year,people,firms,wrong\ngrid-a,2024,1,2,3\n" })), "PREPARE_MISSING_COLUMN");
  const long = mapping(); long.csv = { format: "long", idColumn: "grid", yearColumn: "year", metricColumn: "code", valueColumn: "value", metricCodes: { population: "p", establishments: "b", workers: "w" } };
  expectedCode(() => prepareDataset(inputs({ map: long, csv: "grid,year,code,value\ngrid-a,2024,other,1\n" })), "PREPARE_NO_SELECTED_METRICS");
  long.csv.metricCodes.workers = "b";
  expectedCode(() => prepareDataset(inputs({ map: long })), "PREPARE_INVALID_MAPPING");
});

test("unsupported legacy encoding cannot silently become replacement characters", () => {
  const input = inputs(); input.csvBytes = Buffer.from([0x67, 0x72, 0x69, 0x64, 0x2c, 0xbc, 0xad, 0xbf, 0xef]);
  expectedCode(() => prepareDataset(input), "PREPARE_NOT_UTF8");
});

test("explicit CP949 decoding supports a known extension that Node euc-kr can silently misdecode", () => {
  assert.equal(decodeCSV(Buffer.from("8141b0a1", "hex"), "euc-kr").text, "갂가");
  assert.equal(decodeCSV(Buffer.from("8141", "hex"), "euc-kr").sourceEncoding, "cp949");
  for (const hex of ["81", "8120", "ffff", "ff", "80"]) expectedCode(() => decodeCSV(Buffer.from(hex, "hex"), "euc-kr"), "PREPARE_INVALID_CP949");
});

test("headerless CP949 four-column SGIS layout is mapped explicitly and retains raw and decoded hashes", () => {
  const map = mapping();
  map.dataset.industryClassification = "산업자료 미확보";
  map.csv = { format: "long", encoding: "euc-kr", header: false, columns: ["BASE_YEAR", "GRID_CD", "STAT_CD", "VALUE"], idColumn: "GRID_CD", yearColumn: "BASE_YEAR", metricColumn: "STAT_CD", valueColumn: "VALUE", metricCodes: { population: "to_in_001" } };
  // to_in_001 is confirmed in SGIS dataBook04; 8141 is the known CP949 encoding of 갂.
  // Values 10 and 20 below are synthetic. Unavailable industry codes are not invented.
  const rawCSV = Buffer.concat([Buffer.from("2024,"), Buffer.from("8141", "hex"), Buffer.from(",to_in_001,10\r\n2024,"), Buffer.from("b0a1", "hex"), Buffer.from(",to_in_001,20\r\n")]);
  const input = inputs({ map, geojson: collection([point("갂"), point("가", 127.2, 36.6)]) }); input.csvBytes = rawCSV;
  const { dataset, summary } = prepareDataset(input);
  assert.equal(dataset.cells.find(cell => cell.id === "갂").population.value, 10);
  assert.equal(dataset.cells.find(cell => cell.id === "가").population.value, 20);
  assert.deepEqual(dataset.cells[0].establishments, { status: "not_acquired", value: null });
  assert.equal(dataset.sourceSha256, digest(rawCSV)); assert.equal(dataset.sourceEncoding, "cp949"); assert.equal(dataset.sourceTransform, "none");
  assert.equal(dataset.derivedCsvSha256, digest(Buffer.from("2024,갂,to_in_001,10\r\n2024,가,to_in_001,20\r\n", "utf8")));
  assert.notEqual(dataset.sourceSha256, dataset.derivedCsvSha256); assert.equal(summary.statisticRows, 2);
});

test("a population-only mapping keeps unmapped business and worker metrics unknown rather than zero", () => {
  const map = mapping(); map.dataset.industryClassification = "산업자료 미확보";
  map.csv.metricColumns = { population: "people" };
  const { dataset } = prepareDataset(inputs({ map, csv: "grid,year,people\ngrid-a,2024,10\ngrid-b,2024,0\n" }));
  assert.equal(dataset.industryClassification, "산업자료 미확보");
  for (const cell of dataset.cells) for (const metric of ["establishments", "workers"]) assert.deepEqual(cell[metric], { status: "not_acquired", value: null });
  assert.deepEqual(dataset.cells[1].population, { status: "protected_zero", value: 0 });
});

test("one explicit long metric is sufficient; unused codes are counted and zero selected matches still fails", () => {
  const map = mapping(); map.dataset.industryClassification = "산업자료 미확보";
  map.csv = { format: "long", idColumn: "grid", yearColumn: "year", metricColumn: "code", valueColumn: "value", metricCodes: { population: "to_in_001" } };
  const { dataset, summary } = prepareDataset(inputs({ map, csv: "grid,year,code,value\ngrid-a,2024,to_in_001,10\ngrid-a,2024,SYNTHETIC_UNSELECTED,9\n" }));
  assert.equal(summary.selectedRows, 1); assert.equal(summary.unselectedRows, 1);
  assert.deepEqual(dataset.cells[0].workers, { status: "not_acquired", value: null });
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid,year,code,value\ngrid-a,2024,SYNTHETIC_UNSELECTED,9\n" })), "PREPARE_NO_SELECTED_METRICS");
  map.csv.metricCodes = {};
  expectedCode(() => prepareDataset(inputs({ map })), "PREPARE_INVALID_MAPPING");
});

test("headerless UTF-8 requires ordered columns and neither layout nor encoding is guessed", () => {
  const map = mapping(); map.csv.header = false; map.csv.columns = ["grid", "year", "people", "firms", "workers"];
  const source = "grid-a,2024,10,2,3\ngrid-b,2024,20,4,6\n";
  assert.equal(prepareDataset(inputs({ map, csv: source })).dataset.cells.length, 2);
  expectedCode(() => prepareDataset(inputs({ csv: source })), "PREPARE_MISSING_COLUMN");
  delete map.csv.columns;
  expectedCode(() => prepareDataset(inputs({ map, csv: source })), "PREPARE_INVALID_MAPPING");
  map.csv.columns = ["grid", "year", "people", "firms", "workers"]; map.csv.encoding = "cp949";
  expectedCode(() => prepareDataset(inputs({ map, csv: source })), "PREPARE_INVALID_MAPPING");
});

test("headerless records keep duplicate, mixed-year and strict column-count protection", () => {
  const map = mapping(); map.csv.header = false; map.csv.columns = ["grid", "year", "people", "firms", "workers"];
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid-a,2024,10,2,3\ngrid-a,2024,20,4,6\n" })), "PREPARE_DUPLICATE_STATISTIC");
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid-a,2023,10,2,3\n" })), "PREPARE_MIXED_YEAR");
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid-a,2024,10,2\n" })), "PREPARE_INVALID_CSV");
  map.csv.encoding = "euc-kr"; map.dataset.sourceTransform = "utf8_conversion";
  expectedCode(() => prepareDataset(inputs({ map, csv: "grid-a,2024,10,2,3\n" })), "PREPARE_INVALID_MAPPING");
});

test("complete coverage must be an explicit frame declaration and must contain all grid centers", () => {
  const map = mapping(); map.dataset.completeFrame = true; delete map.dataset.coverageBBox;
  expectedCode(() => prepareDataset(inputs({ map })), "PREPARE_INVALID_MAPPING");
  map.dataset.coverageBBox = [127.15, 36, 129, 38];
  expectedCode(() => prepareDataset(inputs({ map })), "PREPARE_INVALID_COVERAGE");
  map.dataset.coverageBBox = [126, 35, 129, 38];
  assert.equal(prepareDataset(inputs({ map })).dataset.completeFrame, true);
});

test("unknown fields, unsupported provider and one column reused for different metrics fail", () => {
  const unknown = mapping(); unknown.dataset.guessCodes = true;
  expectedCode(() => prepareDataset(inputs({ map: unknown })), "PREPARE_UNKNOWN_FIELD");
  const provider = mapping(); provider.dataset.provider = "unknown";
  expectedCode(() => prepareDataset(inputs({ map: provider })), "PREPARE_INVALID_MAPPING");
  const duplicate = mapping(); duplicate.csv.metricColumns.workers = "people";
  expectedCode(() => prepareDataset(inputs({ map: duplicate })), "PREPARE_INVALID_MAPPING");
});

test("argument parser rejects unknown flags, duplicates, missing values and source/output path reuse", () => {
  for (const args of [["--collect"], ["--csv"], ["--csv", "a", "--csv", "b"], ["--help", "--csv", "a"]]) expectedCode(() => parseArgs(args), "PREPARE_ARGUMENT");
  expectedCode(() => parseArgs(["--csv", "same", "--geojson", "b", "--mapping", "c", "--boundary-source", "d", "--out", "same"]), "PREPARE_ARGUMENT");
  assert.deepEqual(parseArgs(["--help"]), { help: true });
});

test("50,001 features fail before normalization; bundle output is bounded to 8 MiB", () => {
  assert.equal(MAX_CELLS, 50000); assert.equal(MAX_OUTPUT_BYTES, 8 * 1024 * 1024);
  expectedCode(() => prepareDataset(inputs({ geojson: collection(Array.from({ length: MAX_CELLS + 1 }, (_, index) => point(`grid-${index}`))) })), "PREPARE_TOO_MANY_CELLS");
  const features = Array.from({ length: 35000 }, (_, index) => point(`synthetic-${index.toString().padStart(6, "0")}-${"x".repeat(65)}`, 126 + (index % 500) / 1000, 35 + Math.floor(index / 500) / 1000));
  const csv = "grid,year,people,firms,workers\n" + features.map(feature => `${feature.properties.grid_id},2024,1,2,3`).join("\n");
  expectedCode(() => prepareDataset(inputs({ geojson: collection(features), csv })), "PREPARE_OUTPUT_TOO_LARGE");
});

test("CLI creates one new bundle, refuses overwrite, and never changes its source files", t => {
  const fixturePrefix = path.resolve(os.tmpdir(), "catchment-preparation-fixture-");
  const folder = fs.mkdtempSync(fixturePrefix);
  t.after(() => {
    const resolved = path.resolve(folder);
    assert.ok(resolved.startsWith(fixturePrefix) && path.dirname(resolved) === path.dirname(fixturePrefix), "Only the test-owned temp directory may be removed");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const input = inputs(), names = { csvBytes: "statistics.csv", geojsonBytes: "grids.geojson", mappingBytes: "mapping.json", boundarySourceBytes: "original.zip" };
  for (const [key, name] of Object.entries(names)) fs.writeFileSync(path.join(folder, name), input[key]);
  const script = path.join(__dirname, "prepare_catchment_grid.cjs"), output = path.join(folder, "prepared.json");
  const args = [script, "--csv", path.join(folder, names.csvBytes), "--geojson", path.join(folder, names.geojsonBytes), "--mapping", path.join(folder, names.mappingBytes), "--boundary-source", path.join(folder, names.boundarySourceBytes), "--out", output];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).cells, 2);
  const outputHash = digest(fs.readFileSync(output));
  const again = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /EEXIST/); assert.equal(digest(fs.readFileSync(output)), outputHash);
  for (const [key, name] of Object.entries(names)) assert.deepEqual(fs.readFileSync(path.join(folder, name)), input[key]);
});
