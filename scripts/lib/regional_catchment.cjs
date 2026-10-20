"use strict";

const crypto = require("node:crypto");

const VERSION = "regional-catchment-grid-v1";
const MAX_CELLS = 50000;
const EARTH_RADIUS_KM = 6371.0088;
const METRICS = Object.freeze({ population: "명", establishments: "개", workers: "명" });
const STATUSES = new Set(["observed_public", "protected_zero", "suppressed", "not_provided", "not_acquired"]);
const OFFICIAL_DOMAINS = ["sgis.mods.go.kr", "sgis.kostat.go.kr", "kosis.kr", "data.go.kr", "ngii.go.kr", "map.ngii.go.kr"];
const SOURCE_CATALOG = Object.freeze([
  { provider: "SGIS", label: "공식 소지역 통계·격자 자료", url: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", note: "공식 원본과 코드집을 확보한 뒤 격자 중심점으로 정규화해 가져옵니다. 화면 조회는 외부 자료를 수집하지 않습니다." },
  { provider: "SGIS", label: "생활권역 통계 유의사항", url: "https://sgis.mods.go.kr/view/catchmentArea/main", note: "공개 0은 비밀보호 값일 수 있으므로 실제 0으로 확정하지 않습니다." },
  { provider: "국토지리정보원", label: "국토통계 격자 인구 자료", url: "https://www.data.go.kr/data/15059921/fileData.do", note: "원본 좌표계·격자 해상도·통계 및 경계 연도 확인이 필요합니다." },
  { provider: "KOSIS", label: "행정구역 기초 통계", url: "https://kosis.kr/openapi/devGuide/devGuide_0201List.do", note: "시군구 합계를 반경 인구·산업 총계로 대체하지 않습니다." }
]);

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, max = 300) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault("CATCHMENT_INVALID_INPUT");
}
function sourceUrl(value, official = false) {
  let url;
  try { url = new URL(value); } catch { throw fault("CATCHMENT_INVALID_SOURCE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname || url.hostname === "localhost"
    || /^\d+(?:\.\d+){3}$/.test(url.hostname) || official && !OFFICIAL_DOMAINS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw fault("CATCHMENT_INVALID_SOURCE");
  if (url.href.length > 1000 || [...url.searchParams.keys()].some(key => /key|token|secret|password|auth/i.test(key))) throw fault("CATCHMENT_INVALID_SOURCE");
  return url.href;
}
function coordinate(latitude, longitude) {
  // Korean official grid coverage; null, numeric strings, and axis reversal
  // must not become plausible coordinates through Number coercion.
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 32 || latitude > 40 || longitude < 123 || longitude > 133) throw fault("CATCHMENT_INVALID_COORDINATE");
  return { latitude, longitude };
}
function normalizeCenter(input) {
  keys(input, ["latitude", "longitude", "label", "sourceUrl", "confirmed"]);
  if (input.confirmed !== true || !text(input.label)) throw fault("CATCHMENT_CENTER_CONFIRMATION_REQUIRED");
  return { ...coordinate(input.latitude, input.longitude), label: input.label.trim(), sourceUrl: sourceUrl(input.sourceUrl), confirmed: true,
    provenance: "administrator_confirmed", kind: "declared_reference_point" };
}
function normalizeDataset(input) {
  keys(input, ["id", "provider", "sourceUrl", "sourceYear", "boundaryYear", "gridSizeM", "crs", "sourceSha256", "boundarySha256", "industryClassification", "coverageBBox", "completeFrame", "units", "cells", "disclosureMethod", "derivedGeometrySha256", "boundaryHashKind", "sourceHashKind", "sourceTransform", "mappingSha256"]);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(input.id || "") || !text(input.provider, 100)
    || !Number.isInteger(input.sourceYear) || input.sourceYear < 2000 || input.sourceYear > 2100
    || !Number.isInteger(input.boundaryYear) || input.boundaryYear < 2000 || input.boundaryYear > 2100
    || input.crs !== "EPSG:4326" || ![100, 250, 500, 1000].includes(input.gridSizeM)
    || !/^[a-f0-9]{64}$/.test(input.sourceSha256 || "") || !/^[a-f0-9]{64}$/.test(input.boundarySha256 || "")
    || !text(input.industryClassification, 100) || typeof input.completeFrame !== "boolean"
    || !Array.isArray(input.cells) || !input.cells.length || input.cells.length > MAX_CELLS
    || input.derivedGeometrySha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.derivedGeometrySha256)
    || input.boundaryHashKind !== undefined && input.boundaryHashKind !== "original_file"
    || input.sourceHashKind !== undefined && input.sourceHashKind !== "input_csv"
    || input.sourceTransform !== undefined && !["none", "utf8_conversion"].includes(input.sourceTransform)
    || input.mappingSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.mappingSha256)) throw fault("CATCHMENT_INVALID_DATASET");
  keys(input.units, Object.keys(METRICS));
  if (Object.entries(METRICS).some(([key, unit]) => input.units[key] !== unit)) throw fault("CATCHMENT_UNIT_MISMATCH");
  const bbox = input.coverageBBox;
  if (!Array.isArray(bbox) || bbox.length !== 4) throw fault("CATCHMENT_INVALID_COVERAGE");
  coordinate(bbox[1], bbox[0]); coordinate(bbox[3], bbox[2]);
  if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw fault("CATCHMENT_INVALID_COVERAGE");
  const isSgis = /sgis|통계지리|통계청|국가데이터처/i.test(input.provider) || /sgis\./i.test(input.sourceUrl || "");
  const ids = new Set(), locations = new Set();
  const cells = input.cells.map(cell => {
    keys(cell, ["id", "latitude", "longitude", "population", "establishments", "workers", "sourceYear", "industryClassification"]);
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,119}$/u.test(cell.id || "") || ids.has(cell.id)) throw fault("CATCHMENT_DUPLICATE_CELL");
    ids.add(cell.id);
    const point = coordinate(cell.latitude, cell.longitude), position = `${point.latitude.toFixed(9)},${point.longitude.toFixed(9)}`;
    if (locations.has(position)) throw fault("CATCHMENT_DUPLICATE_COORDINATE");
    locations.add(position);
    if (point.longitude < bbox[0] || point.longitude > bbox[2] || point.latitude < bbox[1] || point.latitude > bbox[3]) throw fault("CATCHMENT_CELL_OUTSIDE_COVERAGE");
    if (cell.sourceYear !== undefined && cell.sourceYear !== input.sourceYear || cell.industryClassification !== undefined && cell.industryClassification !== input.industryClassification) throw fault("CATCHMENT_SOURCE_MISMATCH");
    const row = { id: cell.id, ...point };
    for (const [key, unit] of Object.entries(METRICS)) {
      const metric = cell[key]; keys(metric, ["status", "value", "unit", "sourceYear", "industryClassification"]);
      if (!STATUSES.has(metric.status) || metric.unit !== undefined && metric.unit !== unit
        || metric.sourceYear !== undefined && metric.sourceYear !== input.sourceYear
        || metric.industryClassification !== undefined && metric.industryClassification !== input.industryClassification) throw fault("CATCHMENT_SOURCE_MISMATCH");
      if (metric.status === "observed_public" || metric.status === "protected_zero") {
        if (!Number.isSafeInteger(metric.value) || metric.value < 0 || metric.status === "protected_zero" && metric.value !== 0) throw fault("CATCHMENT_INVALID_VALUE");
        if (isSgis && metric.status === "observed_public" && metric.value === 0) throw fault("CATCHMENT_PROTECTED_ZERO_REQUIRED");
      } else if (metric.value !== null) throw fault("CATCHMENT_INVALID_VALUE");
      row[key] = { status: metric.status, value: metric.value };
    }
    return row;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const dataset = { id: input.id, provider: input.provider.trim(), sourceUrl: sourceUrl(input.sourceUrl, true), sourceYear: input.sourceYear,
    boundaryYear: input.boundaryYear, gridSizeM: input.gridSizeM, crs: "EPSG:4326", sourceSha256: input.sourceSha256,
    boundarySha256: input.boundarySha256, industryClassification: input.industryClassification.trim(), coverageBBox: [...bbox], completeFrame: input.completeFrame,
    units: { ...METRICS }, disclosureMethod: text(input.disclosureMethod, 300) || (isSgis ? "source_disclosure_protection" : "source_publication_rules"),
    ...(input.derivedGeometrySha256 ? { derivedGeometrySha256: input.derivedGeometrySha256 } : {}),
    ...(input.boundaryHashKind ? { boundaryHashKind: input.boundaryHashKind } : {}), ...(input.sourceHashKind ? { sourceHashKind: input.sourceHashKind } : {}),
    ...(input.sourceTransform ? { sourceTransform: input.sourceTransform } : {}), ...(input.mappingSha256 ? { mappingSha256: input.mappingSha256 } : {}), cells };
  return { ...dataset, fingerprint: hash(dataset) };
}
function datasetMetadata(dataset) {
  const { cells, ...metadata } = dataset;
  return { ...metadata, cellCount: cells?.length || dataset.cellCount || 0, provenance: "administrator_imported", coverageDeclaration: "administrator_declared_not_independently_verified" };
}
function haversineKm(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function boundingCircle(center, radiusKm) {
  const rad = radiusKm / EARTH_RADIUS_KM, lat = center.latitude * Math.PI / 180;
  const dy = rad * 180 / Math.PI, dx = Math.asin(Math.sin(rad) / Math.cos(lat)) * 180 / Math.PI;
  return [center.longitude - dx, center.latitude - dy, center.longitude + dx, center.latitude + dy];
}
function bboxContainsCircle(bbox, center, radiusKm) {
  const target = boundingCircle(center, radiusKm);
  return target[0] >= bbox[0] && target[1] >= bbox[1] && target[2] <= bbox[2] && target[3] <= bbox[3];
}
function inputFingerprint(center, dataset) { return hash([VERSION, center, dataset.fingerprint]); }
function metricAccumulator(unit) { return { publishedSum: 0, knownCells: 0, missingCells: 0, suppressedCells: 0, protectedZeroCells: 0, notProvidedCells: 0, unit }; }
function addMetric(target, metric) {
  if (metric.status === "observed_public") { target.publishedSum += metric.value; target.knownCells++; }
  else if (metric.status === "protected_zero") target.protectedZeroCells++;
  else if (metric.status === "suppressed") target.suppressedCells++;
  else { target.missingCells++; if (metric.status === "not_provided") target.notProvidedCells++; }
  if (!Number.isSafeInteger(target.publishedSum)) throw fault("CATCHMENT_TOTAL_TOO_LARGE");
}
function completeMetric(raw, coverage) {
  const uncertain = raw.missingCells + raw.suppressedCells + raw.protectedZeroCells;
  const any = raw.knownCells + uncertain > 0;
  return { ...raw, value: coverage.status === "complete" && any && !uncertain ? raw.publishedSum : null,
    publishedSum: raw.knownCells ? raw.publishedSum : null,
    status: coverage.status === "complete" && any && !uncertain ? "observed_public"
      : raw.knownCells ? "partial" : raw.suppressedCells ? "suppressed" : raw.protectedZeroCells ? "protected_zero"
        : raw.notProvidedCells && raw.notProvidedCells === raw.missingCells ? "not_provided" : "not_acquired" };
}
function resultStatus(rings) {
  const metrics = rings.flatMap(ring => Object.values(ring.metrics));
  return metrics.every(metric => metric.value !== null) ? "ready" : metrics.some(metric => metric.publishedSum !== null) ? "partial" : "missing";
}
function validateCatchmentResult(result, { regionKey, center, datasetFingerprint, requireResultId = true } = {}) {
  try {
    keys(result, ["calculationVersion", "sourceFingerprint", "calculatedAt", "scope", "dataset", "status", "method", "rings", "networkAttempted", "notes", "resultId"]);
    if (result.calculationVersion !== VERSION || !/^[a-f0-9]{64}$/.test(result.sourceFingerprint || "") || result.networkAttempted !== false
      || !Number.isFinite(Date.parse(result.calculatedAt)) || requireResultId && !/^[a-f0-9-]{36}$/.test(result.resultId || "")) throw new Error();
    keys(result.scope, ["regionKey", "label", "center"]);
    if (!text(result.scope.regionKey, 120) || !text(result.scope.label, 300) || regionKey !== undefined && result.scope.regionKey !== regionKey) throw new Error();
    const point = normalizeCenter({ latitude: result.scope.center?.latitude, longitude: result.scope.center?.longitude, label: result.scope.center?.label,
      sourceUrl: result.scope.center?.sourceUrl, confirmed: result.scope.center?.confirmed });
    if (hash(point) !== hash(result.scope.center) || center && hash(point) !== hash(center)) throw new Error();
    const dataset = result.dataset;
    keys(dataset, ["id", "provider", "sourceUrl", "sourceYear", "boundaryYear", "gridSizeM", "crs", "sourceSha256", "boundarySha256", "industryClassification",
      "coverageBBox", "completeFrame", "units", "disclosureMethod", "derivedGeometrySha256", "boundaryHashKind", "sourceHashKind", "sourceTransform", "mappingSha256",
      "fingerprint", "cellCount", "provenance", "coverageDeclaration"]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(dataset.id || "") || !text(dataset.provider, 100) || dataset.crs !== "EPSG:4326"
      || ![100, 250, 500, 1000].includes(dataset.gridSizeM) || !Number.isSafeInteger(dataset.cellCount) || dataset.cellCount < 1 || dataset.cellCount > MAX_CELLS
      || !Number.isInteger(dataset.sourceYear) || dataset.sourceYear < 2000 || dataset.sourceYear > 2100 || !Number.isInteger(dataset.boundaryYear) || dataset.boundaryYear < 2000 || dataset.boundaryYear > 2100
      || !/^[a-f0-9]{64}$/.test(dataset.fingerprint || "") || !/^[a-f0-9]{64}$/.test(dataset.sourceSha256 || "") || !/^[a-f0-9]{64}$/.test(dataset.boundarySha256 || "")
      || !text(dataset.industryClassification, 100) || typeof dataset.completeFrame !== "boolean" || dataset.provenance !== "administrator_imported"
      || dataset.coverageDeclaration !== "administrator_declared_not_independently_verified" || datasetFingerprint && dataset.fingerprint !== datasetFingerprint) throw new Error();
    sourceUrl(dataset.sourceUrl, true);
    if (dataset.derivedGeometrySha256 !== undefined && !/^[a-f0-9]{64}$/.test(dataset.derivedGeometrySha256)
      || dataset.mappingSha256 !== undefined && !/^[a-f0-9]{64}$/.test(dataset.mappingSha256)
      || dataset.boundaryHashKind !== undefined && dataset.boundaryHashKind !== "original_file" || dataset.sourceHashKind !== undefined && dataset.sourceHashKind !== "input_csv"
      || dataset.sourceTransform !== undefined && !["none", "utf8_conversion"].includes(dataset.sourceTransform)) throw new Error();
    if (!Array.isArray(dataset.coverageBBox) || dataset.coverageBBox.length !== 4) throw new Error();
    coordinate(dataset.coverageBBox[1], dataset.coverageBBox[0]); coordinate(dataset.coverageBBox[3], dataset.coverageBBox[2]);
    if (!(dataset.coverageBBox[0] < dataset.coverageBBox[2] && dataset.coverageBBox[1] < dataset.coverageBBox[3])) throw new Error();
    keys(dataset.units, Object.keys(METRICS)); if (Object.entries(METRICS).some(([key, unit]) => dataset.units[key] !== unit)) throw new Error();
    if (result.sourceFingerprint !== inputFingerprint(point, dataset)) throw new Error();
    keys(result.method, ["distance", "earthRadiusKm", "inclusion", "radiiKm", "boundaryPolicy", "gridBoundaryAccuracy", "coverageBasis"]);
    if (result.method.distance !== "wgs84-haversine" || result.method.earthRadiusKm !== EARTH_RADIUS_KM || result.method.inclusion !== "cell-center"
      || hash(result.method.radiiKm) !== hash([50, 100]) || result.method.boundaryPolicy !== "0<=d<=50;50<d<=100"
      || result.method.coverageBasis !== "administrator_declared_not_independently_verified") throw new Error();
    if (!Array.isArray(result.rings) || result.rings.length !== 3 || !Array.isArray(result.notes) || result.notes.some(note => typeof note !== "string" || note.length > 1000)) throw new Error();
    const ringSpecs = [["inner50", 0, 50], ["outer50to100", 50, 100], ["total100", 0, 100]], integer = value => Number.isSafeInteger(value) && value >= 0;
    const isSgis = /sgis|통계지리|통계청|국가데이터처/i.test(dataset.provider) || /sgis\./i.test(dataset.sourceUrl);
    const hasBothBands = result.rings[0]?.coverage?.selectedCells > 0 && result.rings[1]?.coverage?.selectedCells > 0;
    for (let index = 0; index < ringSpecs.length; index++) {
      const ring = result.rings[index], [key, min, max] = ringSpecs[index];
      keys(ring, ["key", "label", "minKm", "maxKm", "coverage", "metrics"]);
      if (ring.key !== key || ring.minKm !== min || ring.maxKm !== max || !text(ring.label, 100)) throw new Error();
      keys(ring.coverage, ["status", "completeFrame", "declaredByAdmin", "bboxContainsCircle", "selectedCells", "boundaryCells"]);
      const coverage = ring.coverage, covered = bboxContainsCircle(dataset.coverageBBox, point, max);
      if (coverage.completeFrame !== dataset.completeFrame || coverage.declaredByAdmin !== true || coverage.bboxContainsCircle !== covered
        || !integer(coverage.selectedCells) || coverage.selectedCells > dataset.cellCount || !integer(coverage.boundaryCells) || coverage.boundaryCells > coverage.selectedCells) throw new Error();
      const coverageComplete = coverage.completeFrame && covered && coverage.selectedCells > 0 && (key !== "total100" || hasBothBands);
      if (coverage.status !== (coverageComplete ? "complete" : "partial")) throw new Error();
      keys(ring.metrics, Object.keys(METRICS));
      for (const [name, unit] of Object.entries(METRICS)) {
        const metric = ring.metrics[name];
        keys(metric, ["publishedSum", "knownCells", "missingCells", "suppressedCells", "protectedZeroCells", "notProvidedCells", "unit", "value", "status"]);
        if (metric.unit !== unit || ["knownCells", "missingCells", "suppressedCells", "protectedZeroCells", "notProvidedCells"].some(count => !integer(metric[count]))
          || metric.knownCells + metric.missingCells + metric.suppressedCells + metric.protectedZeroCells !== coverage.selectedCells || metric.notProvidedCells > metric.missingCells
          || (metric.knownCells ? !integer(metric.publishedSum) : metric.publishedSum !== null)
          || isSgis && metric.knownCells > 0 && metric.publishedSum < metric.knownCells) throw new Error();
        const expected = completeMetric({ publishedSum: metric.publishedSum ?? 0, knownCells: metric.knownCells, missingCells: metric.missingCells,
          suppressedCells: metric.suppressedCells, protectedZeroCells: metric.protectedZeroCells, notProvidedCells: metric.notProvidedCells, unit }, coverage);
        if (Object.entries(expected).some(([field, value]) => metric[field] !== value)) throw new Error();
      }
    }
    const [inner, outer, total] = result.rings;
    if (total.coverage.selectedCells !== inner.coverage.selectedCells + outer.coverage.selectedCells) throw new Error();
    for (const key of Object.keys(METRICS)) {
      const a = inner.metrics[key], b = outer.metrics[key], c = total.metrics[key];
      for (const field of ["knownCells", "missingCells", "suppressedCells", "protectedZeroCells", "notProvidedCells"]) if (c[field] !== a[field] + b[field]) throw new Error();
      const sum = (a.publishedSum ?? 0) + (b.publishedSum ?? 0);
      if (c.publishedSum !== (c.knownCells ? sum : null) || c.value !== null && (a.value === null || b.value === null || c.value !== a.value + b.value)) throw new Error();
    }
    if (result.status !== resultStatus(result.rings)) throw new Error();
    return result;
  } catch { throw fault("CATCHMENT_RESULT_INVALID", 503); }
}
async function calculateCatchment({ regionKey, label, center, dataset, now = () => new Date(), yieldEvery = 512 } = {}) {
  const point = normalizeCenter({ latitude: center?.latitude, longitude: center?.longitude, label: center?.label, sourceUrl: center?.sourceUrl, confirmed: center?.confirmed });
  const rings = [
    { key: "inner50", label: "0~50km", minKm: 0, maxKm: 50 },
    { key: "outer50to100", label: "50km 초과~100km", minKm: 50, maxKm: 100 },
    { key: "total100", label: "누적 100km", minKm: 0, maxKm: 100 }
  ].map(ring => ({ ...ring, coverage: { status: "partial", completeFrame: dataset.completeFrame, declaredByAdmin: true,
    bboxContainsCircle: bboxContainsCircle(dataset.coverageBBox, point, ring.maxKm), selectedCells: 0, boundaryCells: 0 },
    metrics: Object.fromEntries(Object.entries(METRICS).map(([key, unit]) => [key, metricAccumulator(unit)])) }));
  const halfDiagonalKm = dataset.gridSizeM * Math.SQRT2 / 2000;
  for (let index = 0; index < dataset.cells.length; index++) {
    const cell = dataset.cells[index], distance = haversineKm(point, cell);
    for (const ring of rings) {
      if (distance > ring.maxKm + 1e-9 || ring.minKm > 0 && distance <= ring.minKm + 1e-9) continue;
      ring.coverage.selectedCells++;
      if (Math.abs(distance - ring.maxKm) <= halfDiagonalKm || ring.minKm > 0 && Math.abs(distance - ring.minKm) <= halfDiagonalKm) ring.coverage.boundaryCells++;
      for (const key of Object.keys(METRICS)) addMetric(ring.metrics[key], cell[key]);
    }
    if (yieldEvery > 0 && index > 0 && index % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
  }
  for (const ring of rings) {
    // The importer must supply every frame cell, including null/suppressed
    // cells. This declaration is retained; it is never called official proof.
    const hasBothBands = rings[0].coverage.selectedCells > 0 && rings[1].coverage.selectedCells > 0;
    if (ring.coverage.completeFrame && ring.coverage.bboxContainsCircle && ring.coverage.selectedCells && (ring.key !== "total100" || hasBothBands)) ring.coverage.status = "complete";
    ring.metrics = Object.fromEntries(Object.entries(ring.metrics).map(([key, raw]) => [key, completeMetric(raw, ring.coverage)]));
  }
  return { calculationVersion: VERSION, sourceFingerprint: inputFingerprint(point, dataset), calculatedAt: new Date(now()).toISOString(),
    scope: { regionKey, label, center: point }, dataset: datasetMetadata(dataset),
    status: resultStatus(rings),
    method: { distance: "wgs84-haversine", earthRadiusKm: EARTH_RADIUS_KM, inclusion: "cell-center", radiiKm: [50, 100],
      boundaryPolicy: "0<=d<=50;50<d<=100", gridBoundaryAccuracy: "cell-center approximation; boundary cells retained as uncertainty", coverageBasis: "administrator_declared_not_independently_verified" },
    rings, networkAttempted: false,
    notes: ["공식 원본을 관리자가 정규화·반입한 공개 통계의 합계입니다. 제공기관의 반경 실측값이 아닙니다.",
      "누적 100km는 두 구간의 합입니다. 세 항목을 다시 더하지 않습니다.", "비밀보호 0·비공개·미확보는 실제 0으로 계산하지 않습니다. 없는 격자는 0으로 보충하지 않습니다.",
      "자료 범위 완전성은 관리자의 반입 선언이며 제공기관 검증을 뜻하지 않습니다."] };
}

module.exports = { VERSION, MAX_CELLS, EARTH_RADIUS_KM, METRICS, SOURCE_CATALOG, fault, hash, coordinate, normalizeCenter, normalizeDataset, datasetMetadata,
  validateDataset: normalizeDataset, haversineKm, boundingCircle, bboxContainsCircle, inputFingerprint, calculateCatchment, validateCatchmentResult };
