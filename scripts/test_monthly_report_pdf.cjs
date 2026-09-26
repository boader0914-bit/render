"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderMonthlyReportPdf } = require("./lib/monthly_report_pdf.cjs");

function metric(overrides = {}) {
  return { supply: 300, sold: 159, publicBookings: 126, phoneBookings: 33, estimatedRevenue: 31800000, publicRevenue: 25200000, phoneRevenue: 6600000, reservationRate: 0.53, coveredCompanyDays: 30, expectedCompanyDays: 30, coverageRate: 1, revenueCoveredCompanyDays: 30, partial: false, revenuePartial: false, ...overrides };
}
function unknownMetric() { return metric(Object.fromEntries(Object.keys(metric()).map(key => [key, ["partial", "revenuePartial"].includes(key) ? true : null]))); }
function createPdfFixture(options = {}) {
  const daily = Array.from({ length: 31 }, (_, index) => ({ date: `2026-08-${String(index + 1).padStart(2, "0")}`, lodging: index === 30 ? unknownMetric() : metric({ supply: 10, sold: 4 + index % 4, publicBookings: 3 + index % 4, phoneBookings: 1, estimatedRevenue: (4 + index % 4) * 200000, publicRevenue: (3 + index % 4) * 200000, phoneRevenue: 200000, coverageRate: 1 }), dayuse: unknownMetric() }));
  const lodging = metric({ ...Object.fromEntries(["supply", "sold", "publicBookings", "phoneBookings", "estimatedRevenue", "publicRevenue", "phoneRevenue"].map(key => [key, daily.reduce((total, row) => total + (row.lodging[key] || 0), 0)])), reservationRate: 163 / 300, coveredCompanyDays: 30, expectedCompanyDays: 31, coverageRate: 30 / 31, partial: true, revenuePartial: true });
  return {
    id: "monthly_pdf_mock_202608", revision: 4, status: "published", version: 1, type: "company", month: "2026-08", targetId: "mock-company",
    title: "[모의 자료] 가평 숲속의 작은 숙소 월간 보고서", notes: "테스트용 가상 관측 자료입니다. 실서비스의 실적을 의미하지 않습니다.\n공개 예약과 방막기 추정을 나누어 보고, 누락된 날짜와 가격 근거를 확인합니다.",
    createdAt: "2026-09-01T00:00:00Z", publishedAt: "2026-09-01T01:00:00Z",
    snapshot: { request: { type: "company", month: "2026-08", targetId: "mock-company", cutoffDate: "2026-09-01" }, period: { start: "2026-08-01", end: "2026-08-31", days: 31, cutoffDate: "2026-09-01" }, target: { type: "company", id: "mock-company", label: "[모의 자료] 가평 숲속의 작은 숙소" }, summary: { lodging, dayuse: unknownMetric() }, daily,
      companies: [{ companyId: "mock-company", primaryName: "[모의 자료] 가평 숲속의 작은 숙소", regionKey: "kr_gyeonggi_gapyeong", summary: { lodging, dayuse: unknownMetric() }, daily }],
      changes: { lodging: { comparablePairs: 8, firstSold: 18, lastSold: 22, soldChange: 4, firstEstimatedRevenue: 3600000, lastEstimatedRevenue: 4400000, estimatedRevenueChange: 800000 } },
      ranks: { rows: [{ companyId: "mock-company", companyName: "[모의 자료] 가평 숲속의 작은 숙소", keyword: "가평펜션", firstRank: 12, lastRank: 9, rankImprovement: 3 }] },
      quality: { status: "partial", expectedCompanyDays: 31, coveredCompanyDays: 30, coverageRate: 30 / 31, sameDayObservedCompanyDays: 30, staleDays: 0, minObservationLeadTimeDays: 0, maxObservationLeadTimeDays: 0, medianObservationLeadTimeDays: 0, missingCompanyDays: 1, discardedObservationCount: 0, warnings: ["이 문서는 PDF 화면 검토를 위한 가상 자료입니다."] },
      sources: { runIds: ["mock-run-20260831"], runs: [{ id: "mock-run-20260831", keyword: "가평펜션", collectedAt: "2026-08-31T09:00:00Z", selectedObservationCount: 30, collectionQuality: { status: "complete" } }], partialRunIds: [], selectedObservationCount: 30, discardedObservationCount: 0, observationPolicy: "업체·숙박일별 마지막 유효 관측을 선택합니다." },
      context: { sources: [{ key: "mock_population", label: "테스트용 인구 참고 자료", provider: "KOSIS", regionLabel: "가평군", period: "2025", periodType: "Y", retrievedAt: "2026-08-31T00:00:00Z", status: "cached", sourceUrl: "https://kosis.kr/", referenceOnly: true, rows: [{ key: "population", label: "인구 (가상 자료)", value: 12345, unit: "명", status: "ready" }, { key: "missing", label: "미확보 지표", value: null, unit: "명", status: "missing" }] }], warnings: ["외부 통계 역시 검토용 가상 자료입니다."], networkAttempted: false },
      definitions: { estimatedRevenue: "숙박 추정 매출은 관측한 가격과 예약 수량으로 계산한 추정치이며 실제 결제·정산 매출이 아닙니다.", phoneBookings: "방막기 수량은 전화·타채널 예약 등을 포함한 추정치이며 실제 예약을 증명하지 않습니다.", coverage: "관측률은 대상 업체·일 중 유효한 관측이 있는 비중이며 미관측 값은 0으로 대체하지 않습니다." }
    }, ...options
  };
}
function pages(buffer) { return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length; }

// Read the embedded Unicode maps and page text operators. This checks what is
// actually in the PDF, independently of the renderer's formatting functions.
function extractText(buffer) {
  const raw = buffer.toString("latin1");
  const objects = new Map([...raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(match => [match[1], match[2]]));
  const stream = body => {
    const start = body.indexOf("stream\n");
    if (start < 0) return "";
    const bytes = Buffer.from(body.slice(start + 7, body.lastIndexOf("\nendstream")), "latin1");
    try { return (/\/FlateDecode/.test(body) ? require("node:zlib").inflateSync(bytes) : bytes).toString("utf8"); } catch { return ""; }
  };
  const fontMaps = new Map();
  for (const [id, body] of objects) {
    const cmapId = /\/ToUnicode (\d+) 0 R/.exec(body)?.[1];
    if (!cmapId) continue;
    const map = new Map();
    for (const range of stream(objects.get(cmapId)).matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]+)\]/gi)) {
      let code = Number.parseInt(range[1], 16);
      for (const unicode of range[3].matchAll(/<([0-9a-f]+)>/gi)) {
        map.set(code++, String.fromCharCode(...unicode[1].match(/.{4}/g).map(value => Number.parseInt(value, 16))));
      }
    }
    fontMaps.set(id, map);
  }
  const fontAliases = new Map([...raw.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(match => [match[1], fontMaps.get(match[2])]));
  const lines = [];
  for (const body of objects.values()) {
    for (const textBlock of stream(body).matchAll(/BT\s*([\s\S]*?)\s*ET/g)) {
      const alias = /\/(F\d+) [\d.]+ Tf/.exec(textBlock[1])?.[1];
      const map = fontAliases.get(alias);
      if (!map) continue;
      let line = "";
      for (const encoded of textBlock[1].matchAll(/<([0-9a-f]+)>/gi)) {
        for (const code of encoded[1].match(/.{4}/g) || []) line += map.get(Number.parseInt(code, 16)) || "";
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

if (require.main === module) {
  test("published snapshot creates an A4 PDF with embedded Korean regular and bold fonts", async () => {
    const report = createPdfFixture();
    const original = JSON.stringify(report);
    const buffer = await renderMonthlyReportPdf(report);
    const pdf = buffer.toString("latin1");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 8).toString(), "%PDF-1.7");
    assert.match(pdf, /%%EOF\s*$/);
    assert.ok(pages(buffer) >= 4 && pages(buffer) <= 7, `unexpected page count: ${pages(buffer)}`);
    assert.ok((pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length === pages(buffer));
    assert.match(pdf, /\/BaseFont \/[A-Z]+\+Pretendard-Regular/);
    assert.match(pdf, /\/BaseFont \/[A-Z]+\+Pretendard-Bold/);
    assert.ok((pdf.match(/\/FontFile3\b/g) || []).length >= 2, "both OpenType font subsets are embedded");
    assert.ok((pdf.match(/\/ToUnicode\b/g) || []).length >= 2, "both fonts preserve Unicode text maps");
    assert.equal(JSON.stringify(report), original, "rendering must not mutate the published snapshot");
    const text = extractText(buffer);
    assert.match(text, /숙박 추정 매출/);
    assert.match(text, /\[모의 자료\]/);
    assert.match(text, /발행본 · 버전 1/);
    assert.match(text, /발행 v1/);
    assert.match(text, /발행 버전: 1 \/ 수정 번호: 4/);
    assert.doesNotMatch(text, /개정 4|발행 v4|발행본 · 버전 4/);
    assert.match(text, /방막기 추정/);
    assert.match(text, /전화·타채널/);
    assert.match(text, /자료충족률/);
    assert.match(text, /133실·박/);
    assert.match(text, /단위: 실\n/);
    assert.match(text, /숙박 · 일별 객실수 \(실\)/);
    assert.match(text, /12,345/);
    assert.match(text, /2025 \(연간\)/);
    assert.match(text, /참고용/);
    assert.match(text, /미확보/);
    assert.match(text, /https:\/\/kosis\.kr\//);
    assert.match(text, new RegExp(`${pages(buffer)} / ${pages(buffer)}`));
  });

  test("draft, review, and missing snapshots cannot produce published downloads", async () => {
    for (const report of [null, createPdfFixture({ status: "draft" }), createPdfFixture({ status: "review" }), createPdfFixture({ snapshot: null })]) {
      await assert.rejects(renderMonthlyReportPdf(report), { code: "MONTHLY_REPORT_PDF_REQUIRES_PUBLISHED" });
    }
  });

  test("long Korean notes and company names paginate, and input cannot inject PDF actions", async () => {
    const report = createPdfFixture({ notes: "긴 해설은 근거와 해석의 범위를 구분하여 독자에게 설명합니다. ".repeat(160) + ") /OpenAction << /S /JavaScript /JS (alert(1)) >>" });
    report.snapshot.companies = Array.from({ length: 25 }, (_, index) => ({ companyId: `company-${index}`, primaryName: `테스트 숙소 ${index + 1} ` + "산과 강을 바라보는 아주 긴 한글 숙소 이름 ".repeat(4), summary: { lodging: metric() } }));
    const pdf = await renderMonthlyReportPdf(report);
    assert.ok(pages(pdf) > 7 && pages(pdf) < 22, `unexpected long-report page count: ${pages(pdf)}`);
    assert.doesNotMatch(pdf.toString("latin1"), /\/OpenAction\b|\/JavaScript\b|\/Launch\b|\/URI\b/);
  });

  test("all unknown observations, zero observations, and missing optional appendices remain renderable", async () => {
    const report = createPdfFixture();
    report.snapshot = { period: report.snapshot.period, target: report.snapshot.target, summary: { lodging: unknownMetric() }, daily: [{ date: "2026-08-01", lodging: unknownMetric() }, { date: "2026-08-02", lodging: metric({ sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0 }) }], companies: [], quality: {}, sources: {}, definitions: {} };
    const buffer = await renderMonthlyReportPdf(report);
    assert.equal(pages(buffer), 4);
    assert.match(buffer.toString("latin1"), /\/ToUnicode\b/);
    const text = extractText(buffer);
    assert.match(text, /확인 불가/);
    assert.match(text, /2026-08-01\n확인 불가\n확인 불가\n확인 불가\n확인 불가/);
    assert.match(text, /2026-08-02\n0\n0\n0\n0/);
    assert.doesNotMatch(text, /NaN|undefined|null/);
  });

  test("missing font directory fails explicitly instead of falling back to unreadable Korean", async () => {
    await assert.rejects(renderMonthlyReportPdf(createPdfFixture(), { fontDirectory: require("node:path").join(__dirname, "missing-test-fonts") }), /ENOENT/);
  });

  test("complete quantity observations cannot imply complete revenue and partial subtotals stay separate", async () => {
    const report = createPdfFixture();
    report.snapshot.summary.lodging = metric({ estimatedRevenue: null, publicRevenue: null, phoneRevenue: null, revenuePartial: true, knownPartialRevenue: 425000, knownPartialPublicRevenue: 300000, knownPartialBlockedRevenue: 125000 });
    report.snapshot.quality.status = "complete";
    report.snapshot.quality.sameDayObservedCompanyDays = 0;
    report.snapshot.quality.staleDays = 31;
    report.snapshot.quality.minObservationLeadTimeDays = 1;
    report.snapshot.quality.maxObservationLeadTimeDays = 31;
    report.snapshot.quality.medianObservationLeadTimeDays = 15;
    report.snapshot.context.sources[0].status = "not_collected";
    report.snapshot.context.sources[0].period = "";
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.match(text, /수량 관측 상태: 관측 충족/);
    assert.match(text, /금액 근거: 전체 금액 미확보/);
    assert.match(text, /월 최종 예약·매출 실적을 뜻하지 않습니다/);
    assert.match(text, /숙박 추정 매출\n확인 불가/);
    assert.match(text, /일부 가격 근거 소계/);
    assert.match(text, /전체 추정 매출에 포함하거나 더하지 않습니다/);
    assert.match(text, /300,000\n125,000\n425,000/);
    assert.match(text, /기준 기간 미확보/);
    assert.match(text, /자료 상태: 미확보/);
    assert.doesNotMatch(text, /not_collected/);
  });
}

module.exports = { createPdfFixture };
