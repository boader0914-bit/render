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
async function fixture() {
  const center = { latitude: 36.5, longitude: 127.8, label: "검수 기준점 <동쪽>&", sourceUrl: "https://www.data.go.kr/", confirmed: true };
  const dataset = normalizeDataset({ id: "synthetic-annual-reference", provider: "국토지리정보원", sourceUrl: "https://ngii.go.kr/", sourceYear: 2024, boundaryYear: 2025,
    crs: "EPSG:4326", gridSizeM: 1000, sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64), industryClassification: "SYNTHETIC-KSIC:all",
    coverageBBox: [125, 33, 131, 39], completeFrame: true, units: { population: "명", establishments: "개", workers: "명" },
    cells: [36.5, 37.2].map((latitude, i) => ({ id: "synthetic-" + i, latitude, longitude: 127.8,
      population: i ? { status: "observed_public", value: 13 } : { status: "protected_zero", value: 0 },
      establishments: i ? { status: "observed_public", value: 3 } : { status: "suppressed", value: null }, workers: { status: "observed_public", value: 0 } })) });
  const snapshot = { ...await calculateCatchment({ regionKey: "r1", label: "합성 지역", center, dataset, now: () => new Date("2026-10-20T01:00:00Z") }), resultId: "10000000-0000-4000-8000-000000000001" };
  const get = async ({ regionKey }) => regionKey === "r1" ? { scope: { regionKey }, status: snapshot.status, snapshot,
    configuration: { regionKey, center: snapshot.scope.center, inputFingerprint: snapshot.sourceFingerprint, datasetId: dataset.id }, storage: { networkAttempted: false, errorCode: null } }
    : { scope: { regionKey }, status: "missing", snapshot: null, storage: { networkAttempted: false, errorCode: null } };
  const context = await createMonthlyReportCatchmentContext({ catchmentService: { get }, now: () => new Date("2026-10-25T01:00:00Z") })({ type: "keyword", targetId: "합성검색어", month: "2026-09", cutoffDate: "2026-09-30" },
    { companies: [{ companyId: "c1", regionKey: "r1", regionLabel: "합성 <img src=x onerror=alert(1)> 지역" }, { companyId: "c2", regionKey: "r2", regionLabel: "미확보 지역" }] });
  return context;
}

test("HTML retains public zero, unknown totals, suppression and immutable source references with escaped source text", async () => {
  const context = await fixture(), original = JSON.stringify(context), html = ui.renderCatchment(context), value = context.entries[0].snapshot;
  assert.equal(JSON.stringify(context), original); assert.match(html, /확인 불가 명/); assert.match(html, /<td>0 명<\/td>/);
  assert.match(html, /<td>13 명<\/td>/); assert.match(html, /<td>1 \/ 0 \/ 0<\/td>/); assert.match(html, /<td>0 \/ 1 \/ 0<\/td>/);
  assert.match(html, /사용할 저장 근거가 없습니다\. 0으로 계산하지 않습니다/);
  assert.ok(html.includes(value.resultId) && html.includes(value.sourceFingerprint));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img|<script|NaN|undefined/);
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
  for (const coordinate of ["36.5", "127.8"]) { assert.ok(html.includes(coordinate)); assert.ok(compact.includes(coordinate)); }
  assert.match(text, /통계 2024년 \/ 경계 2025년/); assert.match(text, /확인 불가/); assert.match(text, /0명/); assert.match(text, /13명/);
  assert.match(text, /1 \/ 0 \/ 0/); assert.match(text, /0 \/ 1 \/ 0/); assert.match(text, /정상 저장 근거 미확보\. 0으로 계산하지 않습니다/);
  assert.doesNotMatch(pdf.toString("latin1"), /\/JavaScript|\/JS\b/); assert.doesNotMatch(text, /NaN|undefined/);
});

test("long region/evidence strings remain text and multiple regions are never folded into a new total", async () => {
  const context = await fixture(), long = "긴 지역 근거 ".repeat(24);
  context.entries[0].regionLabel = long;
  const second = JSON.parse(JSON.stringify(context.entries[0])); second.regionKey = "r3"; second.regionLabel = "다른 지역";
  context.entries[0].snapshot.rings[0].metrics.workers.value = 314159; context.entries[0].snapshot.rings[0].metrics.workers.publishedSum = 314159;
  second.snapshot.rings[0].metrics.workers.value = 271828; second.snapshot.rings[0].metrics.workers.publishedSum = 271828;
  context.entries.push(second);
  const html = ui.renderCatchment(context), report = createPdfFixture(); report.snapshot.context.catchment = context;
  const text = extractText(await renderMonthlyReportPdf(report));
  for (const output of [html, text]) { assert.ok(output.includes("314,159")); assert.ok(output.includes("271,828")); assert.ok(!output.includes("585,987")); }
  assert.ok(html.includes(long)); assert.match(text, /긴 지역 근거/); assert.match(text, /여러 지역을 합산하지 않습니다/);
});
