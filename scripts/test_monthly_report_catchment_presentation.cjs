"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const ui = require("../web/monthly-reports.js");
const { renderMonthlyReportPdf } = require("./lib/monthly_report_pdf.cjs");
const { createPdfFixture } = require("./test_monthly_report_pdf.cjs");
const { normalizeDataset, calculateCatchment } = require("./lib/regional_catchment.cjs");
const { createMonthlyReportCatchmentContext } = require("./lib/monthly_report_catchment_context.cjs");

// Decode the actual PDF text streams/embedded Unicode maps independently from
// the renderer. Do not use renderer formatters as the expected values.
function extractText(buffer) {
  const raw = buffer.toString("latin1"), objects = new Map([...raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(m => [m[1], m[2]]));
  const stream = body => { if (!body || body.indexOf("stream\n") < 0) return "";
    const bytes = Buffer.from(body.slice(body.indexOf("stream\n") + 7, body.lastIndexOf("\nendstream")), "latin1");
    return (/\/FlateDecode/.test(body) ? require("node:zlib").inflateSync(bytes) : bytes).toString("utf8"); };
  const fontMaps = new Map();
  for (const [id, body] of objects) { const cmap = /\/ToUnicode (\d+) 0 R/.exec(body)?.[1]; if (!cmap) continue;
    const map = new Map();
    for (const range of stream(objects.get(cmap)).matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]+)\]/gi)) {
      let code = Number.parseInt(range[1], 16); for (const u of range[3].matchAll(/<([0-9a-f]+)>/gi)) map.set(code++, String.fromCharCode(...u[1].match(/.{4}/g).map(v => Number.parseInt(v, 16))));
    } fontMaps.set(id, map);
  }
  const aliases = new Map([...raw.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(m => [m[1], fontMaps.get(m[2])])), lines = [];
  for (const body of objects.values()) for (const block of stream(body).matchAll(/BT\s*([\s\S]*?)\s*ET/g)) {
    const map = aliases.get(/\/(F\d+) [\d.]+ Tf/.exec(block[1])?.[1]); if (!map) continue; let line = "";
    for (const encoded of block[1].matchAll(/<([0-9a-f]+)>/gi)) for (const code of encoded[1].match(/.{4}/g) || []) line += map.get(Number.parseInt(code, 16)) || "";
    lines.push(line);
  }
  return lines.join("\n");
}
const ADDRESS = "합성도 합성군 시험로 10 <img src=x onerror=alert(2)>&";
async function fixture({ legacy = false } = {}) {
  const center = { latitude: 36.5, longitude: 127.8, label: "검수 기준점 <동쪽>&", sourceUrl: "https://www.data.go.kr/", confirmed: true,
    ...(legacy ? {} : { address: ADDRESS, companyId: "c1" }) };
  const dataset = normalizeDataset({ id: "synthetic-annual-reference", provider: "국토지리정보원", sourceUrl: "https://ngii.go.kr/", sourceYear: 2024, boundaryYear: 2025,
    crs: "EPSG:4326", gridSizeM: 1000, sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64), industryClassification: "SYNTHETIC-KSIC:all",
    coverageBBox: [125, 33, 131, 39], completeFrame: true, units: { population: "명", establishments: "개", workers: "명" },
    cells: [36.5, 37.2].map((latitude, i) => ({ id: "synthetic-" + i, latitude, longitude: 127.8,
      population: i ? { status: "observed_public", value: 13 } : { status: "protected_zero", value: 0 },
      establishments: i ? { status: "observed_public", value: 3 } : { status: "suppressed", value: null }, workers: { status: "observed_public", value: 0 } })) });
  const snapshot = { ...await calculateCatchment({ regionKey: "r1", ...(legacy ? {} : { companyId: "c1" }), label: "합성 지역", center, dataset, now: () => new Date("2026-10-20T01:00:00Z") }), resultId: "10000000-0000-4000-8000-000000000001" };
  if (legacy) return { schemaVersion: 1, reportMonth: "2026-09", cutoffDate: "2026-09-30", asOfAt: "2026-10-25T01:00:00Z", status: "partial", networkAttempted: false,
    entries: [{ regionKey: "r1", regionLabel: "기존 발행 지역", selectionBasis: "company_actual_location", status: "partial", reasonLabel: "기존 발행 시점 저장 근거", snapshot }], warnings: [] };
  const get = async ({ regionKey, companyId }) => regionKey === "r1" ? { scope: { regionKey, companyId }, status: snapshot.status, snapshot,
    configuration: { regionKey, companyId, center: snapshot.scope.center, inputFingerprint: snapshot.sourceFingerprint, datasetId: dataset.id }, storage: { networkAttempted: false, errorCode: null } }
    : { scope: { regionKey, companyId }, status: "missing", snapshot: null, storage: { networkAttempted: false, errorCode: null } };
  const context = await createMonthlyReportCatchmentContext({ mode: "address_radius", catchmentService: { get }, now: () => new Date("2026-10-25T01:00:00Z") })({ type: "keyword", targetId: "합성검색어", month: "2026-09", cutoffDate: "2026-09-30" },
    { companies: [{ companyId: "c1", regionKey: "r1", regionLabel: "합성 <img src=x onerror=alert(1)> 지역", addressBasis: { status: "ready", address: ADDRESS, basis: "saved_company_address" } },
      { companyId: "c2", regionKey: "r2", regionLabel: "미확보 지역", addressBasis: { status: "ready", address: "합성도 다른군 시험로 20", basis: "saved_company_address" } }] });
  return context;
}

async function regionalFixture({ precise = false } = {}) {
  const { buildRegionalMarketSnapshot } = require("./lib/regional_market.cjs");
  const region = { regionKey: "r1", label: "합성 <img src=x onerror=alert(3)> 지역", officialCode: "48860", level: "local", unitType: "county" };
  const scope = { regionKey: "r1", month: "2026-09", months: 13 }, stamp = "2026-10-20T01:00:00.000Z";
  const proof = { version: "stored-kosis-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "synthetic-population",
    sha256: "d".repeat(64), periodType: "M", period: "2026-09", verifiedAt: stamp,
    checks: ["safe_original_path", "original_sha256", "source_table_and_period", "metadata_region_ancestry", "raw_region_code", "metric_unit_and_period", "stored_metric_values"] };
  const saved = buildRegionalMarketSnapshot({ region, scope, now: () => new Date("2026-10-25T01:00:00Z"), source: { resultSha256: "e".repeat(64) },
    savedSnapshot: { schemaVersion: 1, calculationVersion: "regional-analysis-v1", contractVersion: "regional-data-contract-v1", status: "ready",
      scope, regionIdentity: region, generatedAt: stamp, networkAttempted: false,
      resultId: "20000000-0000-4000-8000-000000000002", sourceFingerprint: "f".repeat(64), groups: [{ key: "kosis", provider: "KOSIS", datasets: [{
        key: "population", periodType: "M", period: "2026-09", retrievedAt: stamp, boundaryYear: 2025,
        rows: [{ key: "population", unit: "명", status: "observed", value: 0 }],
        spatialContract: { version: "regional-data-contract-v1", requestedRegionKey: "r1", officialCode: "48860",
          requestedLevel: "sigungu", providedLevel: "sigungu", requestedUnitType: "county", scopeKind: "administrative", status: "matched",
          evidence: "response", aggregation: "none", provider: "KOSIS", providerRegionCode: "48860", storedProvenance: proof } }] }] } });
  return { schemaVersion: 2, defaultMode: "administrative_region", reportMonth: "2026-10", referenceMonth: scope.month, cutoffDate: "2026-10-22", asOfAt: "2026-10-25T01:00:00.000Z",
    status: "partial", networkAttempted: false, entries: [{ mode: "administrative_region", originKind: "administrative_region", regionKey: "r1", regionLabel: region.label,
      companyIds: ["c1", "c2"], status: "partial", regionSnapshot: saved }],
    preciseEntries: precise ? (await fixture()).entries.filter(entry => entry.snapshot) : [],
    warnings: ["같은 지역은 한 번만 연결하며 지역 간 합산하지 않습니다.", "방문객 출발지·이동권은 미확보입니다."] };
}

test("new regional HTML and PDF keep the administrative scope, true zero, missing metrics, source and as-of separate from a radius", async () => {
  const context = await regionalFixture(), before = JSON.stringify(context), html = ui.renderCatchment(context);
  const report = createPdfFixture(); report.snapshot.context.catchment = context;
  const text = extractText(await renderMonthlyReportPdf(report)), compact = text.replace(/\s/g, "");
  assert.equal(JSON.stringify(context), before); assert.match(html, /지역 배후시장 · 시군구 저장 근거/); assert.match(text, /지역 배후시장/);
  for (const output of [html, text]) {
    assert.match(output, /행정구역 기준/); assert.match(output, /미기록/); assert.match(output, /방문객 출발지·이동권 미확보/);
    assert.match(output, /저장된 주소 반경 정밀 근거 없음/); assert.match(output, /합산하지 않습니다/);
    assert.match(output, /보고 대상월 2026-10/); assert.match(output, /지역 저장분석 참조월 2026-09/);
    assert.doesNotMatch(output, /36\.5|127\.8|NaN|undefined/);
  }
  assert.match(html, /<td>0 명<\/td>/); assert.match(html, /확인 불가 세대/); assert.match(text, /0명/); assert.match(text, /확인 불가/);
  assert.equal((html.match(/<th>총인구<\/th>/g) || []).length, 1, "two selected companies share one region row");
  assert.match(html, /연결 업체 2곳/); assert.match(text, /연결 업체 2곳/);
  assert.match(html, /&lt;img src=x onerror=alert\(3\)&gt;/); assert.doesNotMatch(html, /<img|<script/);
  for (const reference of [context.entries[0].regionSnapshot.source.resultId, "f".repeat(64), "e".repeat(64), "DT_1B040A3", "2026-09"]) {
    assert.ok(html.includes(reference), "HTML region reference missing " + reference); assert.ok(compact.includes(reference), "PDF region reference missing " + reference);
  }
});

test("new regional reports display saved address evidence separately without changing or adding the two scopes", async () => {
  const context = await regionalFixture({ precise: true }), before = JSON.stringify(context), html = ui.renderCatchment(context);
  const report = createPdfFixture(); report.snapshot.context.catchment = context;
  const text = extractText(await renderMonthlyReportPdf(report)), compact = text.replace(/\s/g, "");
  assert.equal(JSON.stringify(context), before); assert.match(html, /별도 주소 반경 정밀 근거/); assert.match(text, /주소 반경 정밀 근거/);
  assert.ok(html.includes(context.preciseEntries[0].snapshot.resultId)); assert.ok(compact.includes(context.preciseEntries[0].snapshot.resultId));
  assert.ok(html.includes("합성도 합성군 시험로 10")); assert.ok(compact.includes(ADDRESS.replace(/\s/g, "")));
  assert.equal(context.entries[0].regionSnapshot.metrics[0].value, 0); assert.equal(context.preciseEntries[0].snapshot.rings[2].metrics.population.value, null);
  assert.match(html, /<td>13 명<\/td>/); assert.match(text, /13명/); assert.doesNotMatch(text, /NaN|undefined/);
});

test("HTML retains public zero, unknown totals, suppression and immutable source references with escaped source text", async () => {
  const context = await fixture(), original = JSON.stringify(context), html = ui.renderCatchment(context), value = context.entries[0].snapshot;
  assert.equal(JSON.stringify(context), original); assert.match(html, /확인 불가 명/); assert.match(html, /<td>0 명<\/td>/);
  assert.match(html, /<td>13 명<\/td>/); assert.match(html, /<td>1 \/ 0 \/ 0<\/td>/); assert.match(html, /<td>0 \/ 1 \/ 0<\/td>/);
  assert.match(html, /사용할 저장 근거가 없습니다\. 0으로 계산하지 않습니다/);
  assert.ok(html.includes(value.resultId) && html.includes(value.sourceFingerprint));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img|<script|NaN|undefined/);
  assert.match(html, /합성도 합성군 시험로 10 &lt;img src=x onerror=alert\(2\)&gt;&amp;/);
  assert.match(html, /관광 수요·매출로 환산하지 않습니다/);
  assert.equal(ui.renderCatchment(undefined), "", "legacy reports gain no invented catchment evidence");
});

test("HTML and actual PDF preserve the same annual evidence, null/zero distinction, center and source IDs", async () => {
  const context = await fixture(), report = createPdfFixture(), value = context.entries[0].snapshot;
  report.snapshot.context.catchment = context; const original = JSON.stringify(report);
  const html = ui.renderCatchment(context), pdf = await renderMonthlyReportPdf(report), text = extractText(pdf), compact = text.replace(/\s/g, "");
  assert.equal(JSON.stringify(report), original); assert.ok(pdf.length > 1000);
  assert.match(text, /반경 배후시장/); assert.match(text, /저장된 연간 배경/); assert.match(text, /보고월의 관광 수요·예약·매출로 환산/);
  for (const ref of [value.resultId, value.sourceFingerprint, value.dataset.id, value.calculationVersion]) {
    assert.ok(html.includes(ref), "HTML missing frozen source reference " + ref); assert.ok(compact.includes(ref), "PDF missing frozen source reference " + ref);
  }
  assert.match(html, /검수 기준점 &lt;동쪽&gt;&amp;/); assert.ok(compact.includes("검수기준점<동쪽>&"));
  assert.ok(compact.includes(ADDRESS.replace(/\s/g, "")), "PDF must preserve the frozen address as inert visible text");
  for (const coordinate of ["36.5", "127.8"]) { assert.ok(html.includes(coordinate)); assert.ok(compact.includes(coordinate)); }
  assert.match(text, /통계 2024년 \/ 경계 2025년/); assert.match(text, /확인 불가/); assert.match(text, /0명/); assert.match(text, /13명/);
  assert.match(text, /1 \/ 0 \/ 0/); assert.match(text, /0 \/ 1 \/ 0/); assert.match(text, /정상 저장 근거 미확보\. 0으로 계산하지 않습니다/);
  assert.doesNotMatch(pdf.toString("latin1"), /\/JavaScript|\/JS\b/); assert.doesNotMatch(text, /NaN|undefined/);
});

test("long evidence strings remain text and separate addresses in the same region never become a new total", async () => {
  const context = await fixture(), long = "긴 지역 근거 ".repeat(24);
  context.entries[0].regionLabel = long;
  const second = JSON.parse(JSON.stringify(context.entries[0])); second.companyId = "c3"; second.regionLabel = "같은 지역의 다른 업체";
  second.snapshot.scope.companyId = "c3"; second.snapshot.scope.center.companyId = "c3"; second.snapshot.scope.center.address = "합성도 합성군 시험로 30";
  context.entries[0].snapshot.rings[0].metrics.workers.value = 314159; context.entries[0].snapshot.rings[0].metrics.workers.publishedSum = 314159;
  second.snapshot.rings[0].metrics.workers.value = 271828; second.snapshot.rings[0].metrics.workers.publishedSum = 271828;
  context.entries.push(second);
  const html = ui.renderCatchment(context), report = createPdfFixture(); report.snapshot.context.catchment = context;
  const text = extractText(await renderMonthlyReportPdf(report));
  for (const output of [html, text]) { assert.ok(output.includes("314,159")); assert.ok(output.includes("271,828")); assert.ok(!output.includes("585,987")); }
  assert.ok(html.includes(long)); assert.match(text, /긴 지역 근거/); assert.match(text, /합산하지 않습니다/);
  assert.ok(html.includes("합성도 합성군 시험로 30")); assert.ok(text.replace(/\s/g, "").includes("합성도합성군시험로30"));
});

test("published legacy reference-point evidence stays readable in HTML and actual PDF without inventing an address", async () => {
  const context = await fixture({ legacy: true }), original = JSON.stringify(context), value = context.entries[0].snapshot;
  assert.equal(value.scope.center.kind, "declared_reference_point"); assert.equal(value.scope.center.address, undefined);
  const html = ui.renderCatchment(context), report = createPdfFixture(); report.snapshot.context.catchment = context;
  const text = extractText(await renderMonthlyReportPdf(report)), compact = text.replace(/\s/g, "");
  assert.equal(JSON.stringify(context), original); assert.match(html, /기존 발행 지역/); assert.match(text, /기존 발행 지역/);
  for (const ref of [value.resultId, value.sourceFingerprint, value.dataset.id]) { assert.ok(html.includes(ref)); assert.ok(compact.includes(ref)); }
  assert.match(html, /검수 기준점 &lt;동쪽&gt;&amp;/); assert.ok(compact.includes("검수기준점<동쪽>&"));
  assert.ok(!html.includes(ADDRESS)); assert.ok(!compact.includes(ADDRESS.replace(/\s/g, ""))); assert.doesNotMatch(html + text, /NaN|undefined/);
});

test("published reports predating catchment evidence retain their original HTML and PDF content", async () => {
  const report = createPdfFixture(), original = JSON.stringify(report);
  assert.equal(ui.renderCatchment(report.snapshot.context.catchment), "");
  const text = extractText(await renderMonthlyReportPdf(report));
  assert.equal(JSON.stringify(report), original); assert.doesNotMatch(text, /반경 배후시장|저장 입력 지문/);
});
