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

function createPdfInsightsFixture() {
  const report = createPdfFixture({ type: "keyword", title: "[모의 자료] 가평펜션 월간 인사이트", targetId: "가평펜션" });
  report.snapshot.target = { type: "keyword", id: "가평펜션", label: "[모의 자료] 가평펜션" };
  const current = { companyCount: 2, coveredCompanyDays: 28, expectedCompanyDays: 28, coverageRate: 1, supply: 200, sold: 95, publicBookings: 75, phoneBookings: 20, estimatedRevenue: 19000000, publicRevenue: 15000000, phoneRevenue: 4000000, reservationRate: 0.475, revenueCoveredCompanyDays: 28, revenueCoverageRate: 1, monthDays: 31 };
  const previous = { ...current, sold: 90, publicBookings: 70, estimatedRevenue: 18000000, publicRevenue: 14000000, reservationRate: 0.45 };
  report.snapshot.comparison = {
    previousMonth: "2026-07", currentMonth: "2026-08", status: "limited", all: { current: { ...current, companyCount: 6 }, previous: { ...previous, companyCount: 5 } },
    common: { companyIds: ["a", "b", "c", "d"], companyCount: 4, current: { ...current, coverageRate: 0.75 }, previous: { ...previous, coverageRate: 0.7 }, matched: { companyCount: 2, companyDays: 28, excludedCompanyDays: 24, current, previous, deltas: { sold: 5, publicBookings: 5, phoneBookings: 0, estimatedRevenue: 1000000, reservationRatePoints: 2.5, estimatedRevenueRate: 1 / 18 } } },
    newlyObservedCompanyIds: ["new-a", "new-b"], noLongerObservedCompanyIds: ["old-a"], warnings: ["비교 조건이 맞지 않는 관측은 증감에서 제외했습니다."], sourceRunIds: ["mock-previous", "mock-current"]
  };
  report.snapshot.insights = {
    schemaVersion: 1,
    pickup: { lodging: { comparableIntervals: 12, public: { status: "ready", increase: 20, decrease: 4, net: 16, comparableIntervals: 12, leadTime: { averageDays: 6, medianDays: 4, averageMinDays: 4, averageMaxDays: 8, bins: [{ key: "early", label: "0~3일", pickup: 12, share: 0.6, intervalCrossingPickup: 4 }, { key: "later", label: "4~7일", pickup: 8, share: 0.4, intervalCrossingPickup: 0 }] } }, blocked: { status: "no_increase", increase: 0, decrease: 2, net: -2, comparableIntervals: 12, leadTime: { averageDays: null, medianDays: null, averageMinDays: null, averageMaxDays: null, bins: [{ key: "early", label: "0~3일", pickup: 0, share: null, intervalCrossingPickup: 0 }, { key: "later", label: "4~7일", pickup: 0, share: null, intervalCrossingPickup: 0 }] } } } },
    pace: { lodging: [{ leadDays: 14, ...unknownMetric() }, { leadDays: 7, ...metric({ supply: 100, sold: 25, publicBookings: 20, phoneBookings: 5, reservationRate: 0.25, coveredCompanyDays: 15, expectedCompanyDays: 31, coverageRate: 15 / 31 }) }, { leadDays: 3, ...metric() }, { leadDays: 1, ...metric() }], dayuse: [] },
    weekdays: { lodging: ["월", "화", "수", "목", "금", "토", "일"].map((label, index) => ({ dayOfWeek: (index + 1) % 7, label, ...metric({ supply: 40, sold: 20, publicBookings: 16, phoneBookings: 4, reservationRate: 0.5, coveredCompanyDays: 4, expectedCompanyDays: 4, coverageRate: 1 }) })), dayuse: [] },
    pricing: { lodging: { pricedCompanyDays: 20, expectedCompanyDays: 31, pricedSupply: 200, pricedSold: 90, estimatedRevenue: 18000000, estimatedPerSoldUnit: 200000, estimatedPerSupplyUnit: 90000, priceCoverageRate: 20 / 31, excludedPriceCompanyDays: 11, containsFallbackPrice: true } },
    geography: { rows: [{ regionKey: "kr_gyeonggi_gapyeong", regionLabel: "경기도 가평군", companyCount: 3, lodging: metric(), dayuse: unknownMetric() }, { regionKey: null, regionLabel: null, companyCount: 1, lodging: unknownMetric(), dayuse: unknownMetric() }] },
    rankVisibility: { rows: [{ companyId: "mock-company", companyName: "[모의 자료] 숲속 숙소", keyword: "가평펜션", observedDays: 3, meanRank: 4, bestRank: 2, worstRank: 6, top3Days: 1, top10Days: 3, top3ObservedShare: 1 / 3, top10ObservedShare: 1 }] },
    calendarGroups: { status: "ready", classifiedDays: 31, missingYears: [], sourceYears: [{ year: 2026, status: "ready", updatedAt: "2026-08-01T00:00:00Z" }], rows: [{ key: "holiday", label: "공휴일", calendarDays: 2, dates: [{ date: "2026-08-15", name: "모의 휴일 A" }, { date: "2026-08-17", name: "모의 휴일 B" }], lodging: metric(), dayuse: unknownMetric() }, { key: "holiday_eve", label: "공휴일 전날", calendarDays: 2, dates: [{ date: "2026-08-14", name: "모의 휴일 A 전날" }, { date: "2026-08-16", name: "모의 휴일 B 전날" }], lodging: metric(), dayuse: unknownMetric() }, { key: "ordinary", label: "그 외 날짜", calendarDays: 27, dates: [], lodging: metric(), dayuse: unknownMetric() }, { key: "unclassified", label: "분류 불가", calendarDays: 0, dates: [], lodging: unknownMetric(), dayuse: unknownMetric() }] },
    sourceRunIds: ["mock-previous", "mock-current"], definitions: { pickup: "증가 관측은 수집 시점 사이에 확인한 변화이며 실제 예약 발생 시각을 증명하지 않습니다.", denominator: "미관측일은 예약 0이나 검색 순위 이탈로 간주하지 않습니다." }
  };
  return report;
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
    assert.doesNotMatch(text, /월간 지표와 비교|전월 비교 · 공통 업체/);
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

  test("new monthly insights print measured pickup, exact pace, weighted weekdays and price cohorts", async () => {
    const report = createPdfInsightsFixture();
    const original = JSON.stringify(report);
    const buffer = await renderMonthlyReportPdf(report);
    const text = extractText(buffer);
    assert.equal(JSON.stringify(report), original);
    assert.ok(pages(buffer) >= 8 && pages(buffer) <= 15, `unexpected insight page count: ${pages(buffer)}`);
    for (const title of ["숙박 예약 증가 관측", "숙박 증가 관측 시차 분포", "숙박일 전 예약 현황", "숙박 요일별 현황", "숙박 가격 근거 지표", "실제 지역별 숙박 현황", "검색 순위 노출 현황", "공휴일과 전날의 예약 현황"]) assert.ok(text.includes(title), title);
    assert.match(text, /D-14\n확인 불가\n확인 불가/);
    assert.match(text, /33.3%/);
    assert.match(text, /대체 가격이 포함/);
    assert.match(text, /경계를 넘는 구간이\s+포함된 항목: 0~3일/);
    assert.match(text, /실제 예약 리드타임으로 단정하지 않습니다/);
    assert.match(text, /미관측일을 순위 이탈로 계산하지 않습니다/);
    assert.match(text, /공휴일과 공휴일 전날이 겹치면 공휴일에만 포함/);
  });

  test("previous-month comparisons use the supplied matched cohort and percentage-point units", async () => {
    const report = createPdfInsightsFixture();
    delete report.snapshot.insights;
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.match(text, /2026-07 → 2026-08/);
    assert.match(text, /공통 4개 업체 중 비교 대상 2개 업체, 28 업체·일/);
    assert.match(text, /제외한 범위 24 업체·일/);
    assert.match(text, /\+2.5%p/);
    assert.match(text, /\+5.6%/);
    assert.match(text, /금액 자료충족률/);
    assert.doesNotMatch(text, /\+250%p/);
    report.snapshot.comparison.common.matched.deltas = { sold: null, publicBookings: null, phoneBookings: null, estimatedRevenue: null, reservationRatePoints: null, estimatedRevenueRate: null };
    const noDeltas = extractText(await renderMonthlyReportPdf(report));
    assert.match(noDeltas, /추정 매출 증감률: 확인 불가/);
    assert.doesNotMatch(noDeltas, /\+2.5%p|\+5.6%|\+1,000,000/);
  });

  test("unavailable previous-month evidence does not invent zero values or comparison deltas", async () => {
    const report = createPdfFixture();
    report.snapshot.comparison = { previousMonth: "2026-07", currentMonth: "2026-08", status: "unavailable", common: { companyCount: 0, matched: { companyCount: 0, companyDays: 0, excludedCompanyDays: null } }, warnings: ["전월 관측 자료가 없습니다."] };
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.match(text, /비교 확인 불가/);
    assert.match(text, /전월 관측 자료가 없습니다/);
    assert.match(text, /미확인 전월 값을 0으로 대체하지 않습니다/);
    assert.doesNotMatch(text, /같은 비교 범위의 추정 매출 증감률|전월 2026-07\n당월 2026-08/);
  });

  test("missing holiday years stay unclassified and pickup baselines stay outside increases", async () => {
    const report = createPdfInsightsFixture();
    report.snapshot.insights.calendarGroups = { status: "unavailable", classifiedDays: 0, missingYears: [2026, 2027], sourceYears: [], rows: [{ key: "unclassified", label: "분류 불가", calendarDays: 31, dates: [], lodging: unknownMetric(), dayuse: unknownMetric() }] };
    Object.assign(report.snapshot.insights.pickup.lodging, { baselinePublicBookings: 42, baselineBlockedBookings: 9, baselineOnlyCompanyDays: 15, offsettingChannelChangeIntervals: 2, includesPartialRuns: true });
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.match(text, /공휴일 자료 미확보 연도: 2026, 2027/);
    assert.match(text, /평일로 간주하지 않고 분류 불가로 남깁니다/);
    assert.match(text, /분류 불가\n31\n확인 불가/);
    assert.match(text, /첫 관측만 있는 15 업체·일은 증가량으로 세지 않습니다/);
    assert.match(text, /채널 간 전환일 수 있어 신규 예약으로 단정하지 않습니다/);
  });

  test("entirely missing context sources are compact while observed zero and mixed rows remain tables", async () => {
    const report = createPdfFixture();
    const base = report.snapshot.context.sources[0];
    report.snapshot.context.sources = [
      { ...base, label: "전부 미확보 통계", status: "missing", rows: [{ label: "빈 지표 A", value: null }, { label: "빈 지표 B", value: "" }] },
      { ...base, label: "관측값 0 통계", rows: [{ label: "확인된 영값", value: 0, unit: "명" }, { label: "부분 미확보 행", value: null, unit: "명" }] }
    ];
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.match(text, /전부 미확보 통계 · 해당 기간 자료 미확보/);
    assert.match(text, /기준 기간 2025 \(연간\) \/ 자료 상태: 미확보 · 참고용/);
    assert.match(text, /원자료: https:\/\/kosis.kr\//);
    assert.doesNotMatch(text, /빈 지표 A|빈 지표 B/);
    assert.match(text, /확인된 영값\n0\n명/);
    assert.match(text, /부분 미확보 행\n미확보\n명/);
  });

  test("empty dayuse accumulator zeros do not produce analysis tables but observed zeros and pickup do", async () => {
    const report = createPdfInsightsFixture();
    const empty = metric({ supply: 0, sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, coveredCompanyDays: 0, revenueCoveredCompanyDays: 0 });
    report.snapshot.summary.dayuse = empty;
    report.snapshot.daily.forEach(row => { row.dayuse = empty; });
    report.snapshot.insights.pace.dayuse = [{ leadDays: 7, ...empty }];
    report.snapshot.insights.weekdays.dayuse = [{ label: "월", ...empty }];
    report.snapshot.insights.pricing.dayuse = { pricedCompanyDays: 0, pricedSupply: 0, pricedSold: 0, estimatedRevenue: 0 };
    report.snapshot.insights.pickup.dayuse = { comparableIntervals: 0, public: { increase: 0, decrease: 0, comparableIntervals: 0 }, blocked: { increase: 0, decrease: 0, comparableIntervals: 0 } };
    const emptyText = extractText(await renderMonthlyReportPdf(report));
    assert.equal((emptyText.match(/데이유즈 분석자료 없음/g) || []).length, 1);
    assert.doesNotMatch(emptyText, /대실 예약 증가 관측|대실 요일별 현황|대실 가격 근거 지표|대실 · 숙박과 별도/);
    report.snapshot.insights.pace.dayuse[0].coveredCompanyDays = 1;
    const observedZero = extractText(await renderMonthlyReportPdf(report));
    assert.match(observedZero, /대실 이용일 전 예약 현황/);
    assert.doesNotMatch(observedZero, /데이유즈 분석자료 없음/);
    report.snapshot.insights.pace.dayuse[0].coveredCompanyDays = 0;
    report.snapshot.insights.pickup.dayuse.comparableIntervals = 2;
    assert.match(extractText(await renderMonthlyReportPdf(report)), /대실 예약 증가 관측/);
  });

  test("scope and per-company price distributions distinguish room capacity, prior-month collections and estimated prices", async () => {
    const report = createPdfInsightsFixture();
    report.snapshot.insights.overview = { companyCount: 6, knownCapacityCompanyCount: 5, totalRooms: 47, capacityComplete: false, collectionDateCount: 9, publicBookingShare: 0.75, blockedBookingShare: 0.25 };
    report.snapshot.insights.pricing.lodging.companyDistribution = { companyCount: 3, medianUnitPrice: 185000, minUnitPrice: 85000, maxUnitPrice: 340000, bands: [{ label: "10만원 미만", companyCount: 1 }, { label: "10~20만원 미만", companyCount: 1 }, { label: "20~30만원 미만", companyCount: 0 }, { label: "30만원 이상", companyCount: 1 }] };
    const original = JSON.stringify(report);
    const text = extractText(await renderMonthlyReportPdf(report));
    assert.equal(JSON.stringify(report), original);
    assert.match(text, /객실 기준 총량/);
    assert.match(text, /47실\n9일\n75%\n25%/);
    assert.match(text, /일부 업체 객실 기준 미확인/);
    assert.match(text, /대상 월 이전의 관측일도 포함/);
    assert.match(text, /중앙값 185,000원/);
    assert.match(text, /업체별 동일 가중치/);
    assert.match(text, /판매 게시 요금이나 실제 결제 단가가 아닙니다/);
    assert.match(text, /20~30만원 미만\n0곳/);
    report.snapshot.insights.overview.publicBookingShare = null;
    report.snapshot.insights.overview.blockedBookingShare = null;
    report.snapshot.insights.pricing.lodging.companyDistribution = { companyCount: 0, medianUnitPrice: null, minUnitPrice: null, maxUnitPrice: null, bands: [] };
    const unknown = extractText(await renderMonthlyReportPdf(report));
    assert.match(unknown, /47실\n9일\n확인 불가\n확인 불가/);
    assert.match(unknown, /0개 업체의 중앙값 확인 불가/);
    assert.doesNotMatch(unknown, /중앙값 0원|undefined|NaN/);
  });
}

module.exports = { createPdfFixture, createPdfInsightsFixture };
