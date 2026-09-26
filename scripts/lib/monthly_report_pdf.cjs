"use strict";

const path = require("node:path");

const COLORS = Object.freeze({ ink: "#182D28", muted: "#66756F", line: "#DDE5DF", pale: "#F3F6F2", green: "#237B58", purple: "#7357A4", purplePale: "#F4F0F8", white: "#FFFFFF" });
const PAGE = Object.freeze({ width: 595.28, height: 841.89, left: 44, right: 44, top: 82, bottom: 777 });
const WIDTH = PAGE.width - PAGE.left - PAGE.right;
const UNKNOWN = "확인 불가";
const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

// All user and source text goes through PDFKit's text encoder, never raw PDF,
// HTML, JavaScript, or link annotations. Remove invisible control characters.
function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").normalize("NFC");
}
function known(value) { return typeof value === "number" && Number.isFinite(value); }
function amount(value, suffix = "") { return known(value) ? `${numberFormatter.format(value)}${suffix}` : UNKNOWN; }
function rate(value) { return known(value) ? `${numberFormatter.format(value * 100)}%` : UNKNOWN; }
function signedAmount(value, suffix = "") { return known(value) ? `${value > 0 ? "+" : ""}${numberFormatter.format(value)}${suffix}` : UNKNOWN; }
function signedRate(value) { return known(value) ? signedAmount(value * 100, "%") : UNKNOWN; }
function array(value) { return Array.isArray(value) ? value : []; }
function dateText(value, withTime = false) {
  if (!value) return UNKNOWN;
  if (!withTime && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return UNKNOWN;
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}) }).format(date);
  return withTime ? `${parts} KST` : parts;
}
function typeLabel(type) { return ({ company: "업체", keyword: "키워드", region: "지역" })[type] || "대상"; }
function qualityLabel(value) { return ({ complete: "관측 충족", ready: "관측 충족", partial: "일부 관측", missing: "근거 없음", insufficient: "관측 부족", empty: "근거 없음" })[value] || clean(value) || UNKNOWN; }
function metricOf(row) { return row && row.lodging && typeof row.lodging === "object" ? row.lodging : {}; }
function hasEvidence(metric) {
  if (!metric) return false;
  const values = [metric.supply, metric.sold, metric.publicBookings, metric.phoneBookings, metric.estimatedRevenue];
  // Explicitly empty cohorts may contain accumulator zeros. Keep genuine
  // observed zeros, but do not present empty accumulators as observed data.
  return values.some(value => known(value) && value !== 0) || values.some(known) && (!known(metric.coveredCompanyDays) || metric.coveredCompanyDays > 0 || metric.revenueCoveredCompanyDays > 0);
}
function hasProductInsightEvidence(snapshot, type) {
  const insights = snapshot.insights || {};
  const metrics = [(snapshot.summary || {})[type], ...array(snapshot.daily).map(row => row[type]), ...array((insights.pace || {})[type]), ...array((insights.weekdays || {})[type]), ...array((insights.calendarGroups || {}).rows).map(row => row[type]), ...array((insights.geography || {}).rows).map(row => row[type])];
  if (metrics.some(metric => hasEvidence(metric) || metric && metric.coveredCompanyDays > 0)) return true;
  const pickup = (insights.pickup || {})[type] || {};
  const pricing = (insights.pricing || {})[type] || {};
  return [pickup.comparableIntervals, pickup.baselineOnlyCompanyDays, pickup.baselinePublicBookings, pickup.baselineBlockedBookings, pricing.pricedCompanyDays, pricing.pricedSupply, pricing.pricedSold, pricing.estimatedRevenue, (pricing.companyDistribution || {}).companyCount,
    ...[pickup.public || {}, pickup.blocked || {}].flatMap(channel => [channel.comparableIntervals, channel.increase, channel.decrease])].some(value => known(value) && value > 0);
}

class ReportLayout {
  constructor(doc, report) { this.doc = doc; this.report = report; this.y = PAGE.top; this.sections = []; }
  font(size = 10, bold = false) { this.doc.font(bold ? "ReportBold" : "ReportRegular").fontSize(size); }
  height(value, width = WIDTH, size = 10, bold = false) {
    this.font(size, bold);
    return this.doc.heightOfString(clean(value), { width, lineGap: 3 });
  }
  text(value, x, y, width, options = {}) {
    const { size = 10, bold = false, color = COLORS.ink, ...textOptions } = options;
    this.font(size, bold);
    this.doc.fillColor(color).text(clean(value), x, y, { width, lineGap: 3, ...textOptions });
  }
  rule(y, x = PAGE.left, width = WIDTH, color = COLORS.line) {
    this.doc.save().strokeColor(color).lineWidth(0.6).moveTo(x, y).lineTo(x + width, y).stroke().restore();
  }
  page(section) {
    this.doc.addPage({ size: "A4", margins: { top: PAGE.top, left: PAGE.left, right: PAGE.right, bottom: 45 } });
    this.sections.push(section);
    this.y = PAGE.top;
    this.text("SABUN DATA LAB", PAGE.left, 31, 230, { size: 10, bold: true, characterSpacing: 1.3 });
    this.text(section, PAGE.left + 245, 33, WIDTH - 245, { size: 8, color: COLORS.muted, align: "right", lineBreak: false });
    this.rule(59);
  }
  ensure(height, section = "월간 보고서 · 계속") { if (this.y + height > PAGE.bottom) this.page(section); }
  heading(title, subtitle = "") {
    this.ensure(70, title);
    const height = this.height(title, WIDTH, 20, true);
    this.text(title, PAGE.left, this.y, WIDTH, { size: 20, bold: true });
    this.y += height + 7;
    if (subtitle) this.paragraph(subtitle, { size: 9, color: COLORS.muted, after: 18 });
    else this.y += 12;
  }
  paragraph(value, options = {}) {
    const { size = 10, color = COLORS.ink, bold = false, after = 11, section = "해설 · 계속" } = options;
    // Split by measured lines so long notes can cross pages without losing text.
    for (const paragraph of clean(value).split("\n")) {
      if (!paragraph) { this.y += 8; continue; }
      let remaining = Array.from(paragraph);
      while (remaining.length) {
        this.ensure(24, section);
        let low = 1; let high = remaining.length; let fit = 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const height = this.height(remaining.slice(0, middle).join(""), WIDTH, size, bold);
          if (height <= PAGE.bottom - this.y) { fit = middle; low = middle + 1; } else high = middle - 1;
        }
        const part = remaining.slice(0, fit).join("");
        const height = this.height(part, WIDTH, size, bold);
        this.text(part, PAGE.left, this.y, WIDTH, { size, color, bold });
        this.y += height;
        remaining = remaining.slice(fit);
        if (remaining.length) this.page(section);
      }
      this.y += after;
    }
  }
  smallHeading(title) {
    this.ensure(47, title);
    this.text(title, PAGE.left, this.y, WIDTH, { size: 12, bold: true });
    this.y += 26;
  }
  table(columns, rows, { section = "상세 표 · 계속", empty = "확인할 수 있는 데이터가 없습니다.", size = 8.5 } = {}) {
    const widths = columns.map(column => column.width * WIDTH);
    const padding = 10;
    const columnRules = (top, bottom) => {
      let x = PAGE.left;
      this.doc.save().strokeColor(COLORS.line).lineWidth(0.4);
      for (const width of widths.slice(0, -1)) { x += width; this.doc.moveTo(x, top).lineTo(x, bottom).stroke(); }
      this.doc.restore();
    };
    const headerHeight = Math.max(32, ...columns.map((column, index) => this.height(column.label, widths[index] - padding * 2, 8, true) + 14));
    const header = () => {
      this.doc.save().rect(PAGE.left, this.y, WIDTH, headerHeight).fill(COLORS.pale).restore();
      columnRules(this.y, this.y + headerHeight);
      let x = PAGE.left;
      columns.forEach((column, index) => {
        this.text(column.label, x + padding, this.y + 8, widths[index] - padding * 2, { size: 8, bold: true, align: column.align || "left" });
        x += widths[index];
      });
      this.y += headerHeight;
    };
    this.ensure(headerHeight + 38, section);
    header();
    if (!rows.length) { this.paragraph(empty, { size: 9, after: 14 }); return; }
    for (const row of rows) {
      const cells = columns.map(column => clean(typeof column.value === "function" ? column.value(row) : row[column.value]));
      // Normal names wrap. Extremely long cells are split over repeated table rows,
      // preserving every character rather than clipping or overflowing the footer.
      let rest = cells.map(cell => Array.from(cell));
      do {
        if (PAGE.bottom - this.y < 42) { this.page(section); header(); }
        const availableHeight = PAGE.bottom - this.y - 15;
        const fragments = rest.map((letters, index) => {
          if (!letters.length) return "";
          let low = 1; let high = letters.length; let fit = 1;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (this.height(letters.slice(0, middle).join(""), widths[index] - padding * 2, size) <= availableHeight) { fit = middle; low = middle + 1; } else high = middle - 1;
          }
          return letters.slice(0, fit).join("");
        });
        const rowHeight = Math.max(29, ...fragments.map((cell, index) => this.height(cell || " ", widths[index] - padding * 2, size) + 15));
        columnRules(this.y, this.y + rowHeight);
        let x = PAGE.left;
        fragments.forEach((cell, index) => {
          this.text(cell, x + padding, this.y + 7, widths[index] - padding * 2, { size, align: columns[index].align || "left", color: columns[index].color || row.color || COLORS.ink });
          rest[index] = rest[index].slice(Array.from(cell).length);
          x += widths[index];
        });
        this.y += rowHeight;
        this.rule(this.y);
        if (rest.some(letters => letters.length)) { this.page(section); header(); }
      } while (rest.some(letters => letters.length));
    }
    this.y += 19;
  }
  footers() {
    const range = this.doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      this.doc.switchToPage(index);
      // Footer text is intentionally below the content margin. Temporarily
      // extend the writable page so PDFKit cannot create an automatic page.
      const bottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.rule(796);
      this.text(`${clean(this.report.month)}  |  발행 v${clean(this.report.version) || UNKNOWN}  |  발행본`, PAGE.left, 807, WIDTH - 65, { size: 7.5, color: COLORS.muted, lineBreak: false });
      this.text(`${index + 1} / ${range.count}`, PAGE.width - PAGE.right - 65, 807, 65, { size: 8, color: COLORS.muted, align: "right", lineBreak: false });
      this.doc.page.margins.bottom = bottomMargin;
    }
  }
}

function drawCover(layout, report, snapshot) {
  const { doc } = layout;
  const target = snapshot.target || {};
  const period = snapshot.period || {};
  const lodging = metricOf(snapshot.summary);
  const quality = snapshot.quality || {};
  layout.page("MONTHLY REPORT");
  layout.text(`${typeLabel(report.type)} 월간 보고서`, PAGE.left, layout.y, WIDTH, { size: 11, bold: true, color: COLORS.green });
  layout.y += 30;
  layout.text(clean(report.month) || UNKNOWN, PAGE.left, layout.y, WIDTH, { size: 38, bold: true });
  layout.y += 64;
  const title = clean(report.title) || `${clean(target.label) || clean(report.targetId) || UNKNOWN} 월간 현황`;
  const titleSize = layout.height(title, WIDTH, 23, true) > 94 ? 17 : 23;
  layout.paragraph(title, { size: titleSize, bold: true, after: 13, section: "월간 요약" });
  layout.paragraph(`${typeLabel(report.type)}: ${clean(target.label) || clean(report.targetId) || UNKNOWN}`, { size: 10, color: COLORS.muted, after: 20 });
  const details = [
    ["대상 기간", `${dateText(period.start)} - ${dateText(period.end)}`],
    ["관측 마감", dateText(period.cutoffDate || (snapshot.request || {}).cutoffDate)],
    ["발행 상태", `발행본 · 버전 ${clean(report.version) || UNKNOWN}`],
    ["생성 / 발행", `${dateText(report.createdAt, true)} / ${dateText(report.publishedAt, true)}`]
  ];
  layout.ensure(118, "월간 요약");
  details.forEach(([label, value]) => {
    layout.text(label, PAGE.left, layout.y, 77, { size: 8, color: COLORS.muted });
    layout.text(value, PAGE.left + 82, layout.y, WIDTH - 82, { size: 8.5 });
    layout.y += 24;
  });
  layout.y += 13;
  const cards = [
    { label: "숙박 추정 매출", value: amount(lodging.estimatedRevenue, "원"), note: !known(lodging.estimatedRevenue) ? "전체 금액 근거 미확보 · 실제 매출 아님" : lodging.revenuePartial ? "금액 근거 일부 누락 · 실제 매출 아님" : "관측한 가격으로 추정 · 실제 매출 아님", color: COLORS.ink },
    { label: "자료충족률 · 수량", value: rate(quality.coverageRate), note: `${amount(quality.coveredCompanyDays)} / ${amount(quality.expectedCompanyDays)} 업체·일\n당일 관측 ${amount(quality.sameDayObservedCompanyDays, " 업체·일")}`, color: COLORS.ink },
    { label: "공개 예약 · 숙박", value: amount(lodging.publicBookings, "실·박"), note: "초록 실선 · 공개 예약으로 관측", color: COLORS.green },
    { label: "방막기 추정 · 숙박", value: amount(lodging.phoneBookings, "실·박"), note: "보라 사선 · 전화·타채널 등 포함", color: COLORS.purple }
  ];
  const gap = 13; const cardWidth = (WIDTH - gap) / 2; const cardHeight = 112;
  layout.ensure(cardHeight * 2 + gap + 12, "월간 핵심 지표");
  const cardY = layout.y;
  cards.forEach((card, index) => {
    const x = PAGE.left + (index % 2) * (cardWidth + gap); const y = cardY + Math.floor(index / 2) * (cardHeight + gap);
    doc.save().roundedRect(x, y, cardWidth, cardHeight, 6).fill(index === 3 ? COLORS.purplePale : COLORS.pale).restore();
    layout.text(card.label, x + 15, y + 14, cardWidth - 30, { size: 9, bold: true, color: card.color });
    layout.font(24, true);
    const valueSize = doc.widthOfString(card.value) > cardWidth - 30 ? 18 : 24;
    layout.text(card.value, x + 15, y + 38, cardWidth - 30, { size: valueSize, bold: true, color: card.color });
    layout.text(card.note, x + 15, y + 83, cardWidth - 30, { size: 7.3, color: COLORS.muted });
  });
  layout.y = cardY + cardHeight * 2 + gap + 18;
  const revenueStatus = !known(lodging.estimatedRevenue) ? "전체 금액 미확보" : lodging.revenuePartial ? "일부 누락" : "확보";
  layout.paragraph(`수량 관측 상태: ${qualityLabel(quality.status)} / 금액 근거: ${revenueStatus}. 미관측 값은 '확인 불가'로 표시하며, 확인된 0과 구분합니다. 숙박과 대실은 합산하지 않습니다.`, { size: 8.5, color: COLORS.muted });
  if (known(quality.staleDays) && quality.staleDays > 0) layout.paragraph(`숙박일 이전의 사전 관측만 있는 ${amount(quality.staleDays)} 업체·일이 포함됩니다. 수량 관측률이 100%여도 월 최종 예약·매출 실적을 뜻하지 않습니다.`, { size: 8.5, color: COLORS.muted });
  if (known(lodging.knownPartialRevenue)) layout.paragraph(`일부 금액 근거 소계: ${amount(lodging.knownPartialRevenue, "원")}. 전체 숙박 추정 매출과 합산하지 않습니다.`, { size: 8.5, color: COLORS.muted });
}

function hatch(doc, x, y, width, height) {
  if (width <= 0 || height <= 0) return;
  doc.save().rect(x, y, width, height).clip().lineWidth(0.5).strokeColor(COLORS.white);
  for (let line = -height; line < width; line += 5) doc.moveTo(x + line, y + height).lineTo(x + line + height, y).stroke();
  doc.restore();
}

function drawTrend(layout, snapshot) {
  const daily = array(snapshot.daily);
  layout.ensure(239, "숙박 예약 추이");
  layout.smallHeading("일별 숙박 예약 객실수");
  const { doc } = layout;
  const y = layout.y; const height = 132; const left = PAGE.left + 37; const width = WIDTH - 37;
  doc.save().rect(PAGE.left, y, 8, 8).fill(COLORS.green).rect(PAGE.left + 125, y, 8, 8).fill(COLORS.purple).restore();
  hatch(doc, PAGE.left + 125, y, 8, 8);
  layout.text("공개 예약 (실선)", PAGE.left + 13, y - 1, 108, { size: 8, color: COLORS.green });
  layout.text("방막기 추정 (사선)", PAGE.left + 138, y - 1, 165, { size: 8, color: COLORS.purple });
  layout.text("단위: 실", PAGE.left + WIDTH - 90, y - 1, 90, { size: 8, color: COLORS.muted, align: "right" });
  const top = y + 29; const base = top + height;
  const hasKnownBookings = daily.some(row => known(metricOf(row).publicBookings) || known(metricOf(row).phoneBookings));
  const maximum = Math.max(1, ...daily.map(row => { const metric = metricOf(row); return (known(metric.publicBookings) ? metric.publicBookings : 0) + (known(metric.phoneBookings) ? metric.phoneBookings : 0); }));
  for (const ratio of [0, 0.5, 1]) {
    const tickY = base - height * ratio;
    layout.rule(tickY, left, width);
    if (hasKnownBookings) layout.text(amount(maximum * ratio), PAGE.left, tickY - 4, 29, { size: 7, color: COLORS.muted, align: "right" });
  }
  if (!hasKnownBookings) layout.text("일별 관측 근거를 확인할 수 없습니다.", left + 10, top + 49, width - 20, { size: 10, color: COLORS.muted, align: "center" });
  const step = width / Math.max(1, daily.length); const barWidth = Math.min(19, step * 0.62);
  daily.forEach((row, index) => {
    const metric = metricOf(row); const x = left + step * index + (step - barWidth) / 2;
    const publicHeight = known(metric.publicBookings) ? Math.max(0, metric.publicBookings) / maximum * height : 0;
    const phoneHeight = known(metric.phoneBookings) ? Math.max(0, metric.phoneBookings) / maximum * height : 0;
    if (publicHeight) doc.save().rect(x, base - publicHeight, barWidth, publicHeight).fill(COLORS.green).restore();
    if (phoneHeight) { doc.save().rect(x, base - publicHeight - phoneHeight, barWidth, phoneHeight).fill(COLORS.purple).restore(); hatch(doc, x, base - publicHeight - phoneHeight, barWidth, phoneHeight); }
    if (!known(metric.publicBookings) || !known(metric.phoneBookings)) layout.text("?", x, base - 12, barWidth, { size: 7, color: COLORS.muted, align: "center" });
    if (index === 0 || index === daily.length - 1 || index % 5 === 4) layout.text(clean(row.date).slice(-2), x - 5, base + 7, barWidth + 10, { size: 7, color: COLORS.muted, align: "center" });
  });
  layout.y = base + 30;
  layout.paragraph("방막기 추정에는 전화·타채널 예약 등이 포함됩니다. ? 표시는 공개 예약 또는 방막기 추정 중 확인되지 않은 항목이 있음을 뜻합니다.", { size: 8, color: COLORS.muted, after: 17 });
}

function drawAnalysis(layout, report, snapshot) {
  layout.page("해설 및 업체별 현황");
  layout.heading("월간 해설", "발행 시점에 저장한 관측 결과와 작성자의 해설입니다.");
  layout.paragraph(clean(report.notes).trim() || "작성된 해설이 없습니다.", { size: 10, after: 17 });
  const warnings = array((snapshot.quality || {}).warnings);
  if (warnings.length) {
    layout.smallHeading("해석 시 확인할 사항");
    warnings.forEach((warning, index) => layout.paragraph(`${index + 1}. ${clean(warning)}`, { size: 8.5, color: COLORS.muted, after: 7 }));
    layout.y += 7;
  }
  drawTrend(layout, snapshot);
  layout.smallHeading("업체별 숙박 요약");
  layout.table([
    { label: "업체", width: 0.35, value: row => row.primaryName || row.companyId || UNKNOWN },
    { label: "공개 예약\n(실·박)", width: 0.14, align: "right", color: COLORS.green, value: row => amount(metricOf(row.summary).publicBookings) },
    { label: "방막기 추정\n(실·박)", width: 0.14, align: "right", color: COLORS.purple, value: row => amount(metricOf(row.summary).phoneBookings) },
    { label: "추정 매출\n(원)", width: 0.23, align: "right", value: row => amount(metricOf(row.summary).estimatedRevenue) },
    { label: "자료충족률", width: 0.14, align: "right", value: row => rate(metricOf(row.summary).coverageRate) }
  ], array(snapshot.companies), { section: "업체별 숙박 요약 · 계속" });
  const lodging = metricOf(snapshot.summary);
  if ([lodging.knownPartialRevenue, lodging.knownPartialPublicRevenue, lodging.knownPartialBlockedRevenue].some(known)) {
    layout.ensure(155, "일부 가격 근거 소계");
    layout.smallHeading("일부 가격 근거 소계 · 숙박");
    layout.paragraph("가격 근거가 확인된 일부 예약의 금액만 표시합니다. 전체 추정 매출에 포함하거나 더하지 않습니다.", { size: 8.5, color: COLORS.muted, after: 9 });
    layout.table([
      { label: "공개 예약 부분 근거 (원)", width: 0.34, align: "right", color: COLORS.green, value: row => amount(row.knownPartialPublicRevenue) },
      { label: "방막기 부분 근거 (원)", width: 0.36, align: "right", color: COLORS.purple, value: row => amount(row.knownPartialBlockedRevenue) },
      { label: "부분 근거 합계 (원)", width: 0.3, align: "right", value: row => amount(row.knownPartialRevenue) }
    ], [lodging], { section: "일부 가격 근거 소계 · 계속", size: 8.5 });
  }
  const dayuse = (snapshot.summary || {}).dayuse;
  if (hasEvidence(dayuse)) {
    layout.smallHeading("대실 요약 · 숙박과 별도");
    layout.paragraph(`공개 예약 ${amount(dayuse.publicBookings, "회")}  /  방막기 추정 ${amount(dayuse.phoneBookings, "회")}  /  추정 매출 ${amount(dayuse.estimatedRevenue, "원")}`, { size: 9 });
    layout.paragraph("대실은 이용 회차 기준이며 숙박 실·박 및 숙박 매출에 더하지 않습니다.", { size: 8, color: COLORS.muted });
  }
  const change = (snapshot.changes || {}).lodging;
  if (change && known(change.comparablePairs) && change.comparablePairs > 0) {
    layout.smallHeading("같은 숙박일의 관측 변화");
    layout.paragraph(`비교 가능한 ${amount(change.comparablePairs)}쌍에서 예약 수량 변화 ${amount(change.soldChange, "실·박")}, 추정 매출 변화 ${amount(change.estimatedRevenueChange, "원")}. 같은 업체·숙박일의 첫 관측과 마지막 관측을 비교한 값입니다. 월간 매출 증가율이 아닙니다.`, { size: 9 });
  }
}

function drawRanks(layout, snapshot) {
  const ranks = array((snapshot.ranks || {}).rows);
  if (ranks.length) {
    layout.ensure(115, "검색 순위 관측");
    layout.smallHeading("검색 순위 관측");
    layout.table([
      { label: "업체 / 키워드", width: 0.52, value: row => `${clean(row.companyName || row.companyId)}\n${clean(row.keyword)}` },
      { label: "첫 순위", width: 0.16, align: "right", value: row => amount(row.firstRank) },
      { label: "마지막 순위", width: 0.16, align: "right", value: row => amount(row.lastRank) },
      { label: "개선 폭", width: 0.16, align: "right", value: row => known(row.rankImprovement) ? `${row.rankImprovement > 0 ? "+" : ""}${amount(row.rankImprovement)}` : UNKNOWN }
    ], ranks, { section: "검색 순위 관측 · 계속" });
  }
}

function drawMonthComparison(layout, comparison) {
  if (!comparison || typeof comparison !== "object") return;
  layout.ensure(520, "전월 비교 · 공통 업체");
  layout.smallHeading("전월 비교 · 공통 업체");
  const common = comparison.common || {};
  const matched = common.matched || {};
  const current = matched.current || {};
  const previous = matched.previous || {};
  const deltas = matched.deltas || {};
  const currentMonth = clean(comparison.currentMonth) || UNKNOWN;
  const previousMonth = clean(comparison.previousMonth) || UNKNOWN;
  const comparable = ["ready", "limited"].includes(comparison.status) && known(matched.companyDays) && matched.companyDays > 0;
  const status = comparable ? comparison.status === "limited" ? "제한된 범위에서 비교" : "비교 가능" : "비교 확인 불가";
  layout.paragraph(`${previousMonth} → ${currentMonth} / ${status}\n공통 ${amount(common.companyCount, "개 업체")} 중 비교 대상 ${amount(matched.companyCount, "개 업체")}, ${amount(matched.companyDays, " 업체·일")}. 비교에서 제외한 범위 ${amount(matched.excludedCompanyDays, " 업체·일")}.`, { size: 9, after: 7, section: "전월 비교 · 계속" });
  if (comparison.all && typeof comparison.all === "object") layout.paragraph(`전체 관측 대상: 전월 ${amount((comparison.all.previous || {}).companyCount, "개 업체")} / 당월 ${amount((comparison.all.current || {}).companyCount, "개 업체")}. 월 달력일: 전월 ${amount((comparison.all.previous || {}).monthDays, "일")} / 당월 ${amount((comparison.all.current || {}).monthDays, "일")}.`, { size: 8, color: COLORS.muted, after: 7, section: "전월 비교 · 계속" });
  const newlyObserved = Array.isArray(comparison.newlyObservedCompanyIds) ? comparison.newlyObservedCompanyIds.length : null;
  const noLongerObserved = Array.isArray(comparison.noLongerObservedCompanyIds) ? comparison.noLongerObservedCompanyIds.length : null;
  layout.paragraph(`당월에 새로 관측된 업체 ${amount(newlyObserved, "곳")} / 전월에만 관측된 업체 ${amount(noLongerObserved, "곳")}. 업체 구성 변화는 아래 증감에 섞지 않습니다.`, { size: 8, color: COLORS.muted, after: 9, section: "전월 비교 · 계속" });
  if (comparable) {
    layout.paragraph("같은 업체의 각 월 같은 일자(예: 7일과 7일) 중 공급 객실수와 관측 시차가 일치하는 기록만 비교했습니다. 실제 결제·정산 실적의 증감이 아닙니다.", { size: 8.5, color: COLORS.muted, after: 11, section: "전월 비교 · 계속" });
    const rows = [
      { label: "공개 예약 (실·박)", previous: amount(previous.publicBookings), current: amount(current.publicBookings), delta: signedAmount(deltas.publicBookings), color: COLORS.green },
      { label: "방막기 추정 (실·박)", previous: amount(previous.phoneBookings), current: amount(current.phoneBookings), delta: signedAmount(deltas.phoneBookings), color: COLORS.purple },
      { label: "예약 합계 (실·박)", previous: amount(previous.sold), current: amount(current.sold), delta: signedAmount(deltas.sold) },
      { label: "추정 매출 (원)", previous: amount(previous.estimatedRevenue), current: amount(current.estimatedRevenue), delta: signedAmount(deltas.estimatedRevenue) },
      { label: "예약률 (%)", previous: rate(previous.reservationRate), current: rate(current.reservationRate), delta: signedAmount(deltas.reservationRatePoints, "%p") }
    ];
    layout.table([
      { label: "비교 지표 · 숙박", width: 0.34, value: "label" },
      { label: `전월 ${previousMonth}`, width: 0.22, align: "right", value: "previous" },
      { label: `당월 ${currentMonth}`, width: 0.22, align: "right", value: "current" },
      { label: "증감", width: 0.22, align: "right", value: "delta" }
    ], rows, { section: "전월 비교 · 공통 업체 · 계속", size: 8.3 });
    layout.paragraph(`같은 비교 범위의 추정 매출 증감률: ${signedRate(deltas.estimatedRevenueRate)}. 전월 분모가 0이거나 금액 근거가 부족하면 증감률은 확인 불가입니다.`, { size: 8.5, color: COLORS.muted, after: 10, section: "전월 비교 · 계속" });
    layout.table([
      { label: "비교에 사용된 자료 범위", width: 0.5, value: "label" },
      { label: "전월", width: 0.25, align: "right", value: "previous" },
      { label: "당월", width: 0.25, align: "right", value: "current" }
    ], [
      { label: "공통 업체 전체의 수량 자료충족률", previous: rate((common.previous || {}).coverageRate), current: rate((common.current || {}).coverageRate) },
      { label: "매칭된 범위의 수량 자료충족률", previous: rate(previous.coverageRate), current: rate(current.coverageRate) },
      { label: "매칭된 범위의 금액 자료충족률", previous: rate(previous.revenueCoverageRate), current: rate(current.revenueCoverageRate) }
    ], { section: "전월 비교 · 자료 범위 · 계속", size: 8.3 });
  } else {
    layout.paragraph("조건이 맞는 전월 비교 근거가 없어 증감을 계산하지 않았습니다. 미확인 전월 값을 0으로 대체하지 않습니다.", { size: 9, color: COLORS.muted, section: "전월 비교 · 계속" });
  }
  array(comparison.warnings).forEach(warning => layout.paragraph(clean(warning), { size: 8, color: COLORS.muted, after: 7, section: "전월 비교 · 유의사항 · 계속" }));
  if (Array.isArray(comparison.sourceRunIds)) layout.paragraph(`전월 비교에 기록된 수집 근거: ${amount(comparison.sourceRunIds.length, "회차")}`, { size: 8, color: COLORS.muted, after: 9 });
}

function drawMonthlyInsights(layout, snapshot) {
  if (!snapshot.insights && !snapshot.comparison) return;
  layout.page("월간 인사이트 및 전월 비교");
  layout.heading("월간 지표와 비교", "발행 시점에 저장된 집계와 비교 범위를 기준으로 읽는 보조 분석입니다.");
  const insights = snapshot.insights;
  if (insights && typeof insights === "object") {
    const overview = insights.overview;
    if (overview && typeof overview === "object") {
      layout.ensure(160, "분석 대상 요약");
      layout.smallHeading("분석 대상 요약");
      layout.table([
        { label: "업체 수", width: 0.17, align: "right", value: row => amount(row.companyCount, "곳") },
        { label: "객실 기준 총량", width: 0.25, align: "right", value: row => amount(row.totalRooms, "실") },
        { label: "수집일 수", width: 0.18, align: "right", value: row => amount(row.collectionDateCount, "일") },
        { label: "공개 예약 비중", width: 0.2, align: "right", color: COLORS.green, value: row => rate(row.publicBookingShare) },
        { label: "방막기 추정 비중", width: 0.2, align: "right", color: COLORS.purple, value: row => rate(row.blockedBookingShare) }
      ], [overview], { section: "분석 대상 요약 · 계속", size: 8.5 });
      layout.paragraph(`객실 기준 확보 업체 ${amount(overview.knownCapacityCompanyCount)} / ${amount(overview.companyCount)}곳${overview.capacityComplete === false ? " · 일부 업체 객실 기준 미확인" : overview.capacityComplete === true ? "" : " · 객실 기준 완전성 확인 불가"}. DB 보정을 우선하고, 없으면 최대 관측 객실수로 추정합니다. 업체별 객실 기준을 한 번씩 합한 총량이며 누적 실·박이 아닙니다.`, { size: 8, color: COLORS.muted, after: 7 });
      layout.paragraph("수집일 수는 숙박 대상 월 이전의 관측일도 포함합니다. 공개 예약·방막기 비중은 숙박 유효 관측의 예약 수량 구성이며 분모가 0이면 확인 불가입니다.", { size: 8, color: COLORS.muted, after: 13 });
    }
    const hasDayuse = hasProductInsightEvidence(snapshot, "dayuse");
    const productTypes = ["lodging", ...(hasDayuse ? ["dayuse"] : [])];
    productTypes.forEach(type => drawProductInsights(layout, insights, type));
    if (!hasDayuse) layout.paragraph("데이유즈 분석자료 없음 · 유효 관측·예약 변화·가격 근거가 없습니다.", { size: 8, color: COLORS.muted, after: 12 });
    drawCalendarGroups(layout, insights.calendarGroups, productTypes);
    const geography = array((insights.geography || {}).rows);
    if (geography.length) {
      layout.ensure(125, "실제 지역별 숙박 현황");
      layout.smallHeading("실제 지역별 숙박 현황");
      layout.paragraph("검색 키워드의 지명이 아닌 저장된 업체 소재지로 나누었습니다. 미확인 소재지는 확인 불가로 구분합니다.", { size: 8.5, color: COLORS.muted, after: 9 });
      layout.table([
        { label: "소재 지역", width: 0.3, value: row => row.regionLabel || UNKNOWN },
        { label: "업체 수", width: 0.1, align: "center", value: row => amount(row.companyCount) },
        { label: "공개 예약\n(실·박)", width: 0.14, align: "right", color: COLORS.green, value: row => amount(metricOf(row).publicBookings) },
        { label: "방막기 추정\n(실·박)", width: 0.14, align: "right", color: COLORS.purple, value: row => amount(metricOf(row).phoneBookings) },
        { label: "추정 매출\n(원)", width: 0.18, align: "right", value: row => amount(metricOf(row).estimatedRevenue) },
        { label: "자료충족률", width: 0.14, align: "right", value: row => rate(metricOf(row).coverageRate) }
      ], geography, { section: "실제 지역별 숙박 현황 · 계속", size: 8 });
    }
    const ranks = array((insights.rankVisibility || {}).rows);
    if (ranks.length) {
      layout.ensure(125, "검색 순위 노출 현황");
      layout.smallHeading("검색 순위 노출 현황");
      layout.paragraph("같은 날의 중복 수집을 제외한 관측일이 분모입니다. 미관측일을 순위 이탈로 계산하지 않습니다.", { size: 8.5, color: COLORS.muted, after: 9 });
      layout.table([
        { label: "업체 / 키워드", width: 0.38, value: row => `${clean(row.companyName) || clean(row.companyId) || UNKNOWN}\n${clean(row.keyword) || UNKNOWN}` },
        { label: "관측일", width: 0.13, align: "right", value: row => amount(row.observedDays, "일") },
        { label: "평균 순위", width: 0.15, align: "right", value: row => amount(row.meanRank) },
        { label: "3위 이내\n관측 비중", width: 0.17, align: "right", value: row => rate(row.top3ObservedShare) },
        { label: "10위 이내\n관측 비중", width: 0.17, align: "right", value: row => rate(row.top10ObservedShare) }
      ], ranks, { section: "검색 순위 노출 현황 · 계속", size: 8.3 });
    }
    const definitions = insights.definitions && typeof insights.definitions === "object" ? Object.values(insights.definitions).filter(value => typeof value === "string") : [];
    if (definitions.length) {
      layout.smallHeading("인사이트를 읽는 기준");
      definitions.forEach(value => layout.paragraph(value, { size: 8, color: COLORS.muted, after: 7, section: "월간 인사이트 · 읽는 기준 · 계속" }));
    }
    if (Array.isArray(insights.sourceRunIds)) layout.paragraph(`인사이트에 기록된 수집 근거: ${amount(insights.sourceRunIds.length, "회차")}`, { size: 8, color: COLORS.muted, after: 12 });
  }
  drawMonthComparison(layout, snapshot.comparison);
}

function drawProductInsights(layout, insights, type) {
  const label = type === "dayuse" ? "대실" : "숙박";
  const unit = type === "dayuse" ? "회" : "실·박";
  const pickup = (insights.pickup || {})[type];
  if (pickup && typeof pickup === "object") {
    layout.ensure(170, `${label} 예약 증가 관측`);
    layout.smallHeading(`${label} 예약 증가 관측`);
    layout.paragraph("연속 수집 사이에 관측된 예약 수량의 증가·감소입니다. 실제 예약 접수 시점이나 확정된 신규 예약 건수는 아닙니다.", { size: 8.5, color: COLORS.muted, after: 9 });
    if ([pickup.baselinePublicBookings, pickup.baselineBlockedBookings, pickup.baselineOnlyCompanyDays].some(known)) layout.paragraph(`첫 관측의 기초 수량: 공개 예약 ${amount(pickup.baselinePublicBookings, unit)}, 방막기 추정 ${amount(pickup.baselineBlockedBookings, unit)}. 첫 관측만 있는 ${amount(pickup.baselineOnlyCompanyDays, " 업체·일")}은 증가량으로 세지 않습니다.`, { size: 8, color: COLORS.muted, after: 8 });
    if (known(pickup.offsettingChannelChangeIntervals) && pickup.offsettingChannelChangeIntervals > 0) layout.paragraph(`공개 예약과 방막기가 반대 방향으로 바뀐 구간 ${amount(pickup.offsettingChannelChangeIntervals)}개가 포함됩니다. 채널 간 전환일 수 있어 신규 예약으로 단정하지 않습니다.`, { size: 8, color: COLORS.muted, after: 8 });
    if (pickup.includesPartialRuns === true) layout.paragraph("일부 수집된 회차의 유효 관측을 포함합니다.", { size: 8, color: COLORS.muted, after: 8 });
    const channels = [
      { label: "공개 예약", value: pickup.public || {}, color: COLORS.green },
      { label: "방막기 추정", value: pickup.blocked || {}, color: COLORS.purple }
    ];
    layout.table([
      { label: `구분 (${unit})`, width: 0.23, value: "label" },
      { label: "증가", width: 0.12, align: "right", value: row => amount(row.value.increase) },
      { label: "감소", width: 0.12, align: "right", value: row => amount(row.value.decrease) },
      { label: "순변화", width: 0.13, align: "right", value: row => signedAmount(row.value.net) },
      { label: "비교 구간", width: 0.16, align: "right", value: row => amount(row.value.comparableIntervals) },
      { label: "숙박일까지\n관측 평균 시차", width: 0.24, align: "right", value: row => amount((row.value.leadTime || {}).averageDays, "일") }
    ], channels, { section: `${label} 예약 증가 관측 · 계속`, size: 8.3 });
    channels.forEach(channel => {
      const lead = channel.value.leadTime || {};
      const status = ({ ready: "증가 관측 있음", insufficient: "비교 근거 부족", no_increase: "비교 범위에서 증가 관측 없음" })[channel.value.status] || "상태 확인 불가";
      layout.paragraph(`${channel.label}: ${status}. 숙박일까지의 시차 중앙값 ${amount(lead.medianDays, "일")}, 수집 사이 구간의 평균 경계 ${amount(lead.averageMinDays, "일")} - ${amount(lead.averageMaxDays, "일")}.`, { size: 8, color: channel.color, after: 7, section: `${label} 예약 증가 관측 · 계속` });
    });
    const bins = new Map();
    for (const channel of ["public", "blocked"]) {
      for (const [index, bin] of array(((pickup[channel] || {}).leadTime || {}).bins).entries()) {
        const key = clean(bin.key) || clean(bin.label) || String(index);
        const row = bins.get(key) || { label: clean(bin.label) || UNKNOWN };
        row[channel] = bin;
        bins.set(key, row);
      }
    }
    if (bins.size) {
      layout.ensure(115, `${label} 증가 관측 시차 분포`);
      layout.smallHeading(`${label} 증가 관측 시차 분포`);
      layout.table([
        { label: "숙박일까지의 관측 시차", width: 0.32, value: "label" },
        { label: "공개 증가", width: 0.17, align: "right", color: COLORS.green, value: row => amount((row.public || {}).pickup) },
        { label: "공개 비중", width: 0.17, align: "right", color: COLORS.green, value: row => rate((row.public || {}).share) },
        { label: "방막기 증가", width: 0.17, align: "right", color: COLORS.purple, value: row => amount((row.blocked || {}).pickup) },
        { label: "방막기 비중", width: 0.17, align: "right", color: COLORS.purple, value: row => rate((row.blocked || {}).share) }
      ], [...bins.values()], { section: `${label} 증가 관측 시차 분포 · 계속`, size: 8.3 });
      const crossingBins = [...bins.values()].filter(row => known((row.public || {}).intervalCrossingPickup) && row.public.intervalCrossingPickup > 0 || known((row.blocked || {}).intervalCrossingPickup) && row.blocked.intervalCrossingPickup > 0).map(row => row.label);
      layout.paragraph(`분포는 증가를 확인한 수집 시점에 배정합니다. 수집 사이 구간이 시차 구분 경계를 넘을 수 있으므로 실제 예약 리드타임으로 단정하지 않습니다.${crossingBins.length ? ` 경계를 넘는 구간이 포함된 항목: ${crossingBins.join(", ")}.` : ""}`, { size: 8, color: COLORS.muted, after: 11 });
    }
  }
  for (const group of [
    { key: "pace", title: type === "dayuse" ? "대실 이용일 전 예약 현황" : "숙박일 전 예약 현황", note: "D-14·D-7·D-3·D-1의 정확한 날짜에 수집된 관측만 사용합니다. 가까운 날짜로 대체하거나 빈 날을 0으로 채우지 않습니다. 시점마다 관측 업체·날짜 구성이 달라 서로 빼서 신규 예약량으로 해석하지 않습니다.", firstLabel: "관측 시점", rowLabel: row => known(row.leadDays) ? `D-${row.leadDays}` : UNKNOWN },
    { key: "weekdays", title: `${label} 요일별 현황`, note: "숙박일의 요일별로 합산했습니다. 예약률은 관측된 공급 객실수를 분모로 하며 단순한 일평균이 아닙니다.", firstLabel: "숙박 요일", rowLabel: row => clean(row.label) || UNKNOWN }
  ]) {
    const rows = array((insights[group.key] || {})[type]);
    if (!rows.length) continue;
    layout.ensure(140, group.title);
    layout.smallHeading(group.title);
    layout.paragraph(group.note, { size: 8.5, color: COLORS.muted, after: 9 });
    layout.table([
      { label: group.firstLabel, width: 0.17, value: group.rowLabel },
      { label: "관측 업체·일", width: 0.17, align: "right", value: row => amount(row.coveredCompanyDays) },
      { label: `공개 예약\n(${unit})`, width: 0.17, align: "right", color: COLORS.green, value: row => amount(row.publicBookings) },
      { label: `방막기 추정\n(${unit})`, width: 0.17, align: "right", color: COLORS.purple, value: row => amount(row.phoneBookings) },
      { label: "예약률", width: 0.15, align: "right", value: row => rate(row.reservationRate) },
      { label: "자료충족률", width: 0.17, align: "right", value: row => rate(row.coverageRate) }
    ], rows, { section: `${group.title} · 계속`, size: 8.3 });
  }
  const pricing = (insights.pricing || {})[type];
  if (pricing && typeof pricing === "object") {
    layout.ensure(170, `${label} 가격 근거 지표`);
    layout.smallHeading(`${label} 가격 근거 지표`);
    layout.paragraph(`금액 근거를 모두 갖춘 ${amount(pricing.pricedCompanyDays)} / ${amount(pricing.expectedCompanyDays)} 업체·일, 자료충족률 ${rate(pricing.priceCoverageRate)}를 사용했습니다. 제외 범위 ${amount(pricing.excludedPriceCompanyDays, " 업체·일")}.`, { size: 8.5, color: COLORS.muted, after: 9 });
    layout.table([
      { label: "지표", width: 0.65, value: "label" },
      { label: "관측 근거 기준", width: 0.35, align: "right", value: "value" }
    ], [
      { label: `가격 근거가 있는 예약 수량 (${unit})`, value: amount(pricing.pricedSold) },
      { label: `가격 근거가 있는 공급 수량 (${unit})`, value: amount(pricing.pricedSupply) },
      { label: "같은 가격 근거 범위의 추정 매출 (원)", value: amount(pricing.estimatedRevenue) },
      { label: `예약 1${unit}당 추정액 (원)`, value: amount(pricing.estimatedPerSoldUnit) },
      { label: `공급 1${unit}당 추정액 (원)`, value: amount(pricing.estimatedPerSupplyUnit) }
    ], { section: `${label} 가격 근거 지표 · 계속`, size: 8.5 });
    layout.paragraph(`예약당·공급당 금액은 동일한 가격 근거 표본에서 계산한 추정 지표이며 실제 매출이 아닙니다.${pricing.containsFallbackPrice === true ? " 대체 가격이 포함되어 있습니다." : pricing.containsFallbackPrice === false ? "" : " 대체 가격 포함 여부는 확인 불가입니다."}`, { size: 8, color: COLORS.muted, after: 12 });
    const distribution = pricing.companyDistribution;
    if (distribution && typeof distribution === "object") {
      layout.ensure(185, `${label} 업체별 추정 예약 단가`);
      layout.smallHeading(`${label} 업체별 추정 예약 단가`);
      layout.paragraph(`전체 금액 근거를 갖춘 ${amount(distribution.companyCount, "개 업체")}의 중앙값 ${amount(distribution.medianUnitPrice, "원")}, 최저 ${amount(distribution.minUnitPrice, "원")} - 최고 ${amount(distribution.maxUnitPrice, "원")}.`, { size: 8.5, after: 9 });
      layout.paragraph(`업체별 추정 매출을 해당 가격 근거의 예약 ${unit}으로 나눈 값에 업체별 동일 가중치를 적용했습니다. 판매 게시 요금이나 실제 결제 단가가 아닙니다.`, { size: 8, color: COLORS.muted, after: 9 });
      layout.table([
        { label: "업체별 추정 예약 단가 구간", width: 0.72, value: row => clean(row.label) || UNKNOWN },
        { label: "업체 수", width: 0.28, align: "right", value: row => amount(row.companyCount, "곳") }
      ], array(distribution.bands), { section: `${label} 업체별 추정 예약 단가 · 계속`, empty: "단가 구간별 업체 수를 확인할 수 없습니다.", size: 8.5 });
    }
  }
}

function drawCalendarGroups(layout, calendar, productTypes) {
  if (!calendar || typeof calendar !== "object") return;
  layout.ensure(200, "공휴일과 전날의 예약 현황");
  layout.smallHeading("공휴일과 전날의 예약 현황");
  const status = ({ ready: "분류 자료 확보", partial: "일부 날짜 분류 불가", unavailable: "공휴일 자료 미확보" })[calendar.status] || UNKNOWN;
  layout.paragraph(`${status} / 분류 가능한 달력일 ${amount(calendar.classifiedDays, "일")}. 공휴일과 공휴일 전날이 겹치면 공휴일에만 포함합니다.`, { size: 8.5, color: COLORS.muted, after: 8 });
  if (array(calendar.missingYears).length) layout.paragraph(`공휴일 자료 미확보 연도: ${calendar.missingYears.map(clean).join(", ")}. 영향을 받는 날짜는 평일로 간주하지 않고 분류 불가로 남깁니다.`, { size: 8.5, color: COLORS.muted, after: 9 });
  for (const type of productTypes) {
    const label = type === "dayuse" ? "대실" : "숙박";
    const unit = type === "dayuse" ? "회" : "실·박";
    if (type === "dayuse") layout.smallHeading("대실 · 숙박과 별도");
    layout.table([
      { label: `${label} 달력 구분`, width: 0.26, value: row => clean(row.label) || ({ holiday: "공휴일", holiday_eve: "공휴일 전날", ordinary: "그 외 날짜", unclassified: "분류 불가" })[row.key] || UNKNOWN },
      { label: "달력일", width: 0.1, align: "right", value: row => amount(row.calendarDays) },
      { label: `공개 예약\n(${unit})`, width: 0.16, align: "right", color: COLORS.green, value: row => amount((row[type] || {}).publicBookings) },
      { label: `방막기 추정\n(${unit})`, width: 0.16, align: "right", color: COLORS.purple, value: row => amount((row[type] || {}).phoneBookings) },
      { label: "예약률", width: 0.14, align: "right", value: row => rate((row[type] || {}).reservationRate) },
      { label: "자료충족률", width: 0.18, align: "right", value: row => rate((row[type] || {}).coverageRate) }
    ], array(calendar.rows), { section: `${label} 공휴일 구분 · 계속`, empty: "공휴일별 분류 근거를 확인할 수 없습니다.", size: 8.3 });
  }
  for (const row of array(calendar.rows).filter(item => ["holiday", "holiday_eve"].includes(item.key) && array(item.dates).length)) {
    layout.paragraph(`${clean(row.label) || (row.key === "holiday" ? "공휴일" : "공휴일 전날")}: ${row.dates.map(item => `${dateText(item.date)}${clean(item.name) ? ` ${clean(item.name)}` : ""}`).join(" / ")}`, { size: 8, color: COLORS.muted, after: 7, section: "공휴일 분류 근거 · 계속" });
  }
  if (array(calendar.sourceYears).length) layout.paragraph(`달력 자료: ${calendar.sourceYears.map(source => `${clean(source.year)}년 ${({ ready: "확보", complete: "확보", cached: "저장 자료", partial: "일부 확보", missing: "미확보", unavailable: "미확보" })[source.status] || UNKNOWN}${source.updatedAt ? ` (저장 ${dateText(source.updatedAt)})` : ""}`).join(" / ")}`, { size: 8, color: COLORS.muted, after: 12 });
}

function drawDaily(layout, snapshot) {
  layout.page("부록 A · 일별 상세");
  layout.heading("일별 관측 상세", "일별 숙박 객실수는 실, 월 누적 수량은 실·박입니다. 대실은 이용 회차, 금액은 원 단위입니다.");
  const columns = type => [
    { label: "날짜", width: 0.19, value: row => dateText(row.date) },
    { label: "공개 예약", width: 0.14, align: "center", color: COLORS.green, value: row => amount((row[type] || {}).publicBookings) },
    { label: "방막기 추정", width: 0.14, align: "center", color: COLORS.purple, value: row => amount((row[type] || {}).phoneBookings) },
    { label: "예약 합계", width: 0.14, align: "center", value: row => amount((row[type] || {}).sold) },
    { label: "추정 매출", width: 0.25, align: "right", value: row => amount((row[type] || {}).estimatedRevenue) },
    { label: "자료충족률", width: 0.14, align: "right", value: row => rate((row[type] || {}).coverageRate) }
  ];
  layout.smallHeading("숙박 · 일별 객실수 (실)");
  layout.table(columns("lodging"), array(snapshot.daily), { section: "부록 A · 숙박 일별 상세 · 계속", size: 8 });
  if (array(snapshot.daily).some(row => hasEvidence(row.dayuse))) {
    layout.smallHeading("대실 · 숙박과 별도");
    layout.table(columns("dayuse"), array(snapshot.daily), { section: "부록 A · 대실 일별 상세 · 계속", size: 8 });
  }
  drawRanks(layout, snapshot);
}

function sourceUrl(value) {
  try {
    const url = new URL(clean(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function drawContext(layout, context) {
  const sources = array((context || {}).sources);
  if (!sources.length && !array((context || {}).warnings).length) return;
  layout.smallHeading("외부 통계 참고 자료");
  layout.paragraph("통계의 기준 기간은 보고 대상 월과 다를 수 있습니다. 연간 자료와 다른 기간 자료는 참고용이며 숙박 매출 산식에 합산하지 않습니다.", { size: 8.5, color: COLORS.muted });
  array((context || {}).warnings).forEach(warning => layout.paragraph(clean(warning), { size: 8, color: COLORS.muted, section: "부록 B · 외부 통계 · 계속" }));
  sources.forEach(source => {
    const status = ({ ready: "확보", cached: "저장 자료", missing: "미확보", not_collected: "미확보", unavailable: "미확보", partial: "일부 확보", needs_key: "미확보", needs_refresh: "갱신 필요" })[source.status] || clean(source.status) || "미확보";
    const period = typeof source.period === "string" || typeof source.period === "number" ? clean(source.period).trim() || "미확보" : "미확보";
    const yearly = ["Y", "A", "yearly", "annual"].includes(source.periodType);
    const url = sourceUrl(source.sourceUrl);
    const rows = array(source.rows);
    if (!rows.some(row => known(row.value) || typeof row.value === "string" && row.value.trim())) {
      const missing = `${clean(source.label) || clean(source.key) || "외부 통계"} · 해당 기간 자료 미확보\n${clean(source.provider) || "제공처 미확보"} / ${clean(source.regionLabel) || "지역 미확보"} / 기준 기간 ${period}${yearly ? " (연간)" : ""} / 자료 상태: ${status}${source.referenceOnly || yearly ? " · 참고용" : ""}${source.retrievedAt ? `\n저장 시점: ${dateText(source.retrievedAt, true)}` : ""}${source.sourceUpdatedAt ? ` / 원자료 갱신: ${dateText(source.sourceUpdatedAt)}` : ""}${url ? `\n원자료: ${url}` : ""}`;
      layout.ensure(layout.height(missing, WIDTH, 8.5) + 13, "부록 B · 외부 통계 · 계속");
      layout.paragraph(missing, { size: 8.5, color: COLORS.muted, after: 13, section: "부록 B · 외부 통계 · 계속" });
      return;
    }
    layout.ensure(122, "부록 B · 외부 통계 · 계속");
    layout.smallHeading(clean(source.label) || clean(source.key) || "외부 통계");
    layout.paragraph(`${clean(source.provider) || "제공처 미확보"} / ${clean(source.regionLabel) || "지역 미확보"} / 기준 기간 ${period}${yearly ? " (연간)" : ""}\n자료 상태: ${status}${source.referenceOnly || yearly ? " · 참고용" : ""}\n저장 시점: ${dateText(source.retrievedAt, true)}${source.sourceUpdatedAt ? ` / 원자료 갱신: ${dateText(source.sourceUpdatedAt)}` : ""}`, { size: 8.5, after: 4, section: "부록 B · 외부 통계 · 계속" });
    if (url) layout.paragraph(`원자료: ${url}`, { size: 7.5, color: COLORS.muted, after: 5, section: "부록 B · 외부 통계 · 계속" });
    layout.table([
      { label: "참고 지표", width: 0.52, value: row => clean(row.label) || clean(row.key) || "지표명 미확보" },
      { label: "값", width: 0.25, align: "right", value: row => known(row.value) ? amount(row.value) : typeof row.value === "string" && row.value.trim() ? clean(row.value) : "미확보" },
      { label: "단위", width: 0.23, value: row => clean(row.unit) || "미확보" }
    ], rows, { section: "부록 B · 외부 통계 · 계속", empty: "확보된 지표가 없습니다.", size: 8.5 });
  });
}

function drawSources(layout, report, snapshot) {
  const sources = snapshot.sources || {}; const quality = snapshot.quality || {};
  layout.page("부록 B · 근거와 산식");
  layout.heading("근거와 읽는 방법", "보고서 발행 시 저장한 자료와 계산 정의를 함께 기록합니다.");
  layout.paragraph(`보고서 ID: ${clean(report.id) || UNKNOWN}\n발행 버전: ${clean(report.version) || UNKNOWN} / 수정 번호: ${amount(report.revision)}\n관측 마감: ${dateText((snapshot.period || {}).cutoffDate)}\n수집 회차: ${amount(Array.isArray(sources.runIds) ? sources.runIds.length : null, "개")} / 선택 관측 ${amount(sources.selectedObservationCount, "건")} / 제외 관측 ${amount(sources.discardedObservationCount, "건")}`, { size: 8.5, after: 5 });
  layout.smallHeading("지표 정의");
  const definitions = snapshot.definitions && typeof snapshot.definitions === "object" ? Object.entries(snapshot.definitions).filter(([, value]) => typeof value === "string") : [];
  if (definitions.length) definitions.forEach(([, value], index) => layout.paragraph(`${index + 1}. ${value}`, { size: 8.5, after: 8, section: "부록 B · 지표 정의 · 계속" }));
  else layout.paragraph("상세 산식은 저장된 보고서에서 확인할 수 없습니다. 추정 매출은 실제 매출이 아니며, 방막기는 전화·타채널 예약 등을 포함한 추정치입니다.", { size: 8.5 });
  if (sources.observationPolicy) layout.paragraph(`관측 선택 기준: ${typeof sources.observationPolicy === "string" ? sources.observationPolicy : UNKNOWN}`, { size: 8.5 });
  layout.paragraph(`자료 품질: ${qualityLabel(quality.status)} / 누락 ${amount(quality.missingCompanyDays)} 업체·일. 일부 수집 회차: ${amount(Array.isArray(sources.partialRunIds) ? sources.partialRunIds.length : null, "개")}. 보고서는 저장된 관측 범위에 한정되며 실제 결제·정산 내역을 대체하지 않습니다.`, { size: 8.5, color: COLORS.muted });
  if (known(quality.sameDayObservedCompanyDays) || known(quality.staleDays)) layout.paragraph(`관측 시점: 당일 ${amount(quality.sameDayObservedCompanyDays, " 업체·일")}, 사전 관측 ${amount(quality.staleDays, " 업체·일")}. 최종 관측과 숙박일 간격은 최소 ${amount(quality.minObservationLeadTimeDays, "일")}, 최대 ${amount(quality.maxObservationLeadTimeDays, "일")}, 중앙 ${amount(quality.medianObservationLeadTimeDays, "일")}입니다.`, { size: 8, color: COLORS.muted, after: 6 });
  layout.smallHeading("수집 근거");
  const runs = array(sources.runs);
  layout.table([
    { label: "회차 / 키워드", width: 0.5, value: row => `${clean(row.id) || UNKNOWN}\n${clean(row.keyword) || UNKNOWN}` },
    { label: "수집 시각 (KST)", width: 0.3, value: row => dateText(row.collectedAt, true).replace(" KST", "") },
    { label: "선택 관측 / 상태", width: 0.2, value: row => `${amount(row.selectedObservationCount)}건\n${qualityLabel((row.collectionQuality || {}).status)}` }
  ], runs, { section: "부록 B · 수집 근거 · 계속", empty: "저장된 수집 회차 근거가 없습니다.", size: 8 });
  if (array(sources.excludedRuns).length) {
    layout.smallHeading("집계에서 제외한 회차");
    array(sources.excludedRuns).forEach(row => layout.paragraph(`${clean(row.id)} / ${clean(row.status)} / ${clean(row.reason)}`, { size: 8, color: COLORS.muted, section: "부록 B · 제외 근거 · 계속" }));
  }
  drawContext(layout, snapshot.context);
}

/** Render a persisted published snapshot only. No network, database reads, or file writes. */
async function renderMonthlyReportPdf(report, options = {}) {
  if (!report || report.status !== "published" || !report.snapshot || typeof report.snapshot !== "object") {
    const error = new Error("발행된 월간 보고서의 저장된 자료가 필요합니다.");
    error.code = "MONTHLY_REPORT_PDF_REQUIRES_PUBLISHED";
    throw error;
  }
  const pdfkit = require("pdfkit");
  const PDFDocument = pdfkit.PDFDocument || pdfkit;
  const createdAt = new Date(report.publishedAt || report.createdAt || 0);
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, size: "A4", compress: true, pdfVersion: "1.7", displayTitle: true, info: {
    Title: clean(report.title) || `${clean(report.month)} 월간 보고서`, Author: "SABUN DATA LAB", Subject: "저장된 관측 근거에 따른 월간 보고서", Creator: "SABUN DATA LAB", CreationDate: Number.isFinite(createdAt.getTime()) ? createdAt : new Date(0)
  } });
  const fontDirectory = options.fontDirectory || path.resolve(__dirname, "../../web/fonts");
  doc.registerFont("ReportRegular", path.join(fontDirectory, "Pretendard-Regular.otf"));
  doc.registerFont("ReportBold", path.join(fontDirectory, "Pretendard-Bold.otf"));
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on("data", chunk => chunks.push(chunk));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  try {
    const layout = new ReportLayout(doc, report);
    drawCover(layout, report, report.snapshot);
    drawAnalysis(layout, report, report.snapshot);
    drawMonthlyInsights(layout, report.snapshot);
    drawDaily(layout, report.snapshot);
    drawSources(layout, report, report.snapshot);
    layout.footers();
    doc.end();
  } catch (error) { doc.destroy(error); }
  return completed;
}

module.exports = { renderMonthlyReportPdf };
