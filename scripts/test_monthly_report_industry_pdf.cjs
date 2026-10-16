"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderMonthlyReportPdf } = require("./lib/monthly_report_pdf.cjs");
const { createPdfFixture } = require("./test_monthly_report_pdf.cjs");

// Decode the actual PDF's Unicode maps instead of asserting renderer strings.
function extractText(buffer) {
  const raw = buffer.toString("latin1");
  const objects = new Map([...raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(match => [match[1], match[2]]));
  const stream = body => {
    const start = String(body || "").indexOf("stream\n");
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
      for (const unicode of range[3].matchAll(/<([0-9a-f]+)>/gi)) map.set(code++, String.fromCharCode(...unicode[1].match(/.{4}/g).map(value => Number.parseInt(value, 16))));
    }
    fontMaps.set(id, map);
  }
  const fontAliases = new Map([...raw.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(match => [match[1], fontMaps.get(match[2])]));
  const lines = [];
  for (const body of objects.values()) for (const block of stream(body).matchAll(/BT\s*([\s\S]*?)\s*ET/g)) {
    const map = fontAliases.get(/\/(F\d+) [\d.]+ Tf/.exec(block[1])?.[1]);
    if (!map) continue;
    let line = "";
    for (const encoded of block[1].matchAll(/<([0-9a-f]+)>/gi)) for (const code of encoded[1].match(/.{4}/g) || []) line += map.get(Number.parseInt(code, 16)) || "";
    lines.push(line);
  }
  return lines.join("\n");
}

function industryEntry(overrides = {}) {
  return {
    request: { industry: "glamping", region: "kr_gyeongnam_sancheong", month: "2026-08", cutoffDate: "2026-08-31" },
    industry: { id: "glamping", label: "글램핑", unitLabel: "객실/동" }, regionLabel: "경상남도 산청군", status: "ready", reasonCode: "",
    summary: { companyCount: 7, observedCompanies: 6, coveredCompanyDays: 155, expectedCompanyDays: 217, coverageRate: 155 / 217,
      reservationRate: 0.417, publicBookings: 351, phoneBookings: 118, sold: 469, publicRevenue: 70200000, phoneRevenue: 23600000, estimatedRevenue: 93800000,
      revenueCoveredCompanyDays: 150, revenuePartial: true, availability: "partial", metricBasis: "equal_company_within_date_then_equal_observed_dates" },
    storage: { key: "2026-08__glamping__kr_gyeongnam_sancheong__2026-08-31", resultVersion: 2, calculationVersion: "industry-analysis-v1", sourceRevision: "source-revision-pdf-test", resultRevision: "result-revision-pdf-test", calculatedAt: "2026-09-02T01:23:00Z", stale: false },
    cohort: { minRank: 1, maxRank: 20, label: "기간 중 네이버 플레이스 1~20위 관측 업체" },
    capacityBasis: { policy: "관리자 검수값 우선, 없으면 고정 최대 관측값", companyCount: 7, reviewedCompanyCount: 2, unreviewedCompanyCount: 5, missingCapacityCompanyCount: 0 },
    definitions: { coverage: "PDF 검수용 자료 확보 정의입니다.", reservationRate: "PDF 검수용 업체 동일 비중 산식입니다." }, warnings: ["PDF 검수용 일부 금액 근거 미확보 안내입니다."], ...overrides
  };
}
function createIndustryPdfFixture(entries = [industryEntry()]) {
  const report = createPdfFixture();
  report.snapshot.industryBenchmarks = { schemaVersion: 1, month: "2026-08", cutoffDate: "2026-08-31", asOfAt: "2026-09-03T00:00:00Z", networkAttempted: false, status: "partial", entries, warnings: [] };
  return report;
}
function appendixText(buffer) {
  const text = extractText(buffer);
  return text.slice(text.indexOf("발행 시 복사한 저장 집계"));
}

if (require.main === module) {
  test("published industry appendix uses saved scope, unweighted rate, channel totals and revision evidence", async () => {
    const report = createIndustryPdfFixture();
    const original = JSON.stringify(report);
    const text = appendixText(await renderMonthlyReportPdf(report));
    assert.equal(JSON.stringify(report), original, "published snapshots must remain unchanged");
    for (const expected of ["경상남도 산청군", "숙박월 2026-08", "관측 마감 2026-08-31", "1~20위", "7개 / 6개", "155 / 217", "71.4%", "41.7%", "공개 예약", "351", "70,200,000", "118", "23,600,000", "469", "93,800,000", "industry-analysis-v1", "source-revision-pdf-test", "result-revision-pdf-test", "2026-09-02 10:23 KST", "월 전체 매출이 아닙니다", "지역 전체 시장 통계가 아닙니다", "본문 합계에 더하지 않습니다", "PDF 검수용 업체 동일 비중 산식입니다", "객실 총량 기준: 관리자 검수값 우선, 없으면 고정 최대 관측값", "관리자 검수 2개 / 검수 전 5개 / 객실 기준 미확보 0개"]) assert.ok(text.replace(/\s+/g, "").includes(expected.replace(/\s+/g, "")), expected);
    assert.doesNotMatch(text, /NaN|undefined/);
  });

  test("missing and queued snapshots disclose their cause without inventing zero totals", async () => {
    const text = appendixText(await renderMonthlyReportPdf(createIndustryPdfFixture([
      industryEntry({ summary: null, status: "queued", reasonCode: "saved_aggregate_not_ready", reasonLabel: "저장 집계의 산출을 기다리고 있습니다.", warnings: [] }),
      industryEntry({ summary: null, status: "unavailable", reasonCode: "saved_aggregate_read_failed", storage: { errorCode: "EIO" }, warnings: [] })
    ])));
    for (const expected of ["집계 갱신 대기", "저장 집계 확인 불가", "saved_aggregate_not_ready", "saved_aggregate_read_failed", "저장 집계의 산출을 기다리고 있습니다.", "저장 확인 오류 EIO", "예약 수량·매출·확보율은 미확인"]) assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /예약 수량\n0|추정 매출\n0|자료 확보율\n0%|공개 예약\n0/);
  });

  test("stale and failed refreshes keep the last saved result visibly separate from fresh ready data", async () => {
    const text = appendixText(await renderMonthlyReportPdf(createIndustryPdfFixture([
      industryEntry({ status: "stale", reasonCode: "source_revision_changed" }),
      industryEntry({ status: "failed", reasonCode: "refresh_failed", storage: { ...industryEntry().storage, stale: true } })
    ])));
    assert.match(text, /갱신 필요 \/ 마지막 정상 저장본 참고/);
    assert.match(text, /최근 집계 갱신 실패 \/ 마지막 정상 저장본 참고 \/ 갱신 필요/);
    assert.match(text, /93,800,000/);
    assert.match(text, /source_revision_changed/);
    assert.match(text, /refresh_failed/);
  });

  test("a real observed zero remains zero while empty accumulator zeros remain unconfirmed", async () => {
    const observed = industryEntry();
    for (const key of ["publicBookings", "phoneBookings", "sold", "publicRevenue", "phoneRevenue", "estimatedRevenue", "reservationRate"]) observed.summary[key] = 0;
    const zero = appendixText(await renderMonthlyReportPdf(createIndustryPdfFixture([observed])));
    assert.match(zero, /공개 예약\n0\n0/);
    assert.match(zero, /타채널 예약 · 방막기 추정\n0\n0/);
    assert.match(zero, /업종 예약률 · 업체 동일 비중\n0%/);
    const missing = industryEntry({ summary: { ...observed.summary, availability: "missing", coveredCompanyDays: 0 } });
    const empty = appendixText(await renderMonthlyReportPdf(createIndustryPdfFixture([missing])));
    assert.match(empty, /유효한 예약·매출 관측이 없습니다/);
    assert.match(empty, /업종 예약률 · 업체 동일 비중\n확인 불가/);
    assert.doesNotMatch(empty, /공개 예약\n0\n0/);
  });

  test("older publications without industry data do not invent an appendix and rendering performs no network read", async () => {
    const originalFetch = global.fetch;
    let requests = 0;
    global.fetch = async () => { requests++; throw new Error("PDF_NETWORK_READ_FORBIDDEN"); };
    try {
      const legacy = extractText(await renderMonthlyReportPdf(createPdfFixture()));
      assert.doesNotMatch(legacy, /업종 참고 집계/);
      const empty = appendixText(await renderMonthlyReportPdf(createIndustryPdfFixture([])));
      assert.match(empty, /연결할 업종 저장 집계가 없습니다/);
      assert.equal(requests, 0);
    } finally { global.fetch = originalFetch; }
  });

  test("saved appendix keeps report input cutoff separate from the closed-month aggregate scope", async () => {
    const report = createIndustryPdfFixture();
    report.snapshot.industryBenchmarks.reportCutoffDate = "2026-09-03";
    const before = JSON.stringify(report.snapshot.industryBenchmarks);
    const text = appendixText(await renderMonthlyReportPdf(report));
    assert.match(text, /관측 마감 2026-08-31 \/ 본문 입력 마감 2026-09-03/);
    assert.match(text, /실제 소재지 기준 지역 \/ 숙박월 2026-08 \/ 관측 마감 2026-08-31/);
    assert.equal(JSON.stringify(report.snapshot.industryBenchmarks), before);
  });
}

module.exports = { createIndustryPdfFixture, industryEntry, extractText };
