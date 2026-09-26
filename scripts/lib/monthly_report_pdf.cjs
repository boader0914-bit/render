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
function hasEvidence(metric) { return metric && [metric.supply, metric.sold, metric.publicBookings, metric.phoneBookings, metric.estimatedRevenue].some(known); }

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
          this.text(cell, x + padding, this.y + 7, widths[index] - padding * 2, { size, align: columns[index].align || "left", color: columns[index].color || COLORS.ink });
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
    layout.ensure(122, "부록 B · 외부 통계 · 계속");
    layout.smallHeading(clean(source.label) || clean(source.key) || "외부 통계");
    const status = ({ ready: "확보", cached: "저장 자료", missing: "미확보", not_collected: "미확보", unavailable: "미확보", partial: "일부 확보", needs_key: "미확보", needs_refresh: "갱신 필요" })[source.status] || clean(source.status) || "미확보";
    const period = typeof source.period === "string" || typeof source.period === "number" ? clean(source.period).trim() || "미확보" : "미확보";
    const yearly = ["Y", "A", "yearly", "annual"].includes(source.periodType);
    layout.paragraph(`${clean(source.provider) || "제공처 미확보"} / ${clean(source.regionLabel) || "지역 미확보"} / 기준 기간 ${period}${yearly ? " (연간)" : ""}\n자료 상태: ${status}${source.referenceOnly || yearly ? " · 참고용" : ""}\n저장 시점: ${dateText(source.retrievedAt, true)}${source.sourceUpdatedAt ? ` / 원자료 갱신: ${dateText(source.sourceUpdatedAt)}` : ""}`, { size: 8.5, after: 4, section: "부록 B · 외부 통계 · 계속" });
    const url = sourceUrl(source.sourceUrl);
    if (url) layout.paragraph(`원자료: ${url}`, { size: 7.5, color: COLORS.muted, after: 5, section: "부록 B · 외부 통계 · 계속" });
    layout.table([
      { label: "참고 지표", width: 0.52, value: row => clean(row.label) || clean(row.key) || "지표명 미확보" },
      { label: "값", width: 0.25, align: "right", value: row => known(row.value) ? amount(row.value) : typeof row.value === "string" && row.value.trim() ? clean(row.value) : "미확보" },
      { label: "단위", width: 0.23, value: row => clean(row.unit) || "미확보" }
    ], array(source.rows), { section: "부록 B · 외부 통계 · 계속", empty: "확보된 지표가 없습니다.", size: 8.5 });
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
    drawDaily(layout, report.snapshot);
    drawSources(layout, report, report.snapshot);
    layout.footers();
    doc.end();
  } catch (error) { doc.destroy(error); }
  return completed;
}

module.exports = { renderMonthlyReportPdf };
