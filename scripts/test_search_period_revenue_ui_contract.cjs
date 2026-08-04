"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = () => {
  throw new Error("Network calls are forbidden in search-period revenue contract tests");
};

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "scripts", "glamping_app_server.cjs"), "utf8");

function functionSource(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected function ${name}`);
  const signatureEnd = source.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `expected function body for ${name}`);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unbalanced function ${name}`);
}

function functionBlock(source, name) {
  const full = functionSource(source, name);
  return full.slice(full.indexOf("{") + 1, -1);
}

const uiContext = vm.createContext({
  state: { data: { run: {} } },
  finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  },
  weeklyRows(item = {}, kind = "lodging") {
    return kind === "day" ? (item.dayRows || []) : (item.lodgingRows || []);
  },
  companyItemFromCurrentRun(company = {}) {
    return company.currentItem || null;
  },
  fmtNumber(value) {
    return Number(value).toLocaleString("ko-KR");
  }
});
for (const name of [
  "parseDate",
  "bookingPeriodDays",
  "bookingDays",
  "adminDbRevenuePeriodProfile",
  "adminDbAverageRevenuePeriodProfile"
]) {
  vm.runInContext(functionSource(app, name), uiContext);
}

const bookingPeriodDays = uiContext.bookingPeriodDays;
assert.equal(bookingPeriodDays({ checkIn: "2026-08-04", checkOut: "2026-08-04" }), 1);
assert.equal(bookingPeriodDays({ checkIn: "2026-08-04", checkOut: "2026-08-05" }), 2, "two inclusive dates must not collapse to one day");
assert.equal(bookingPeriodDays({ checkIn: "2026-08-04", checkOut: "2026-08-10" }), 7);
assert.equal(bookingPeriodDays({ checkIn: "2026-08-24", checkOut: "2026-09-06" }), 14, "month boundaries must remain inclusive");
assert.equal(bookingPeriodDays({ checkIn: "2026-08-24", checkOut: "2026-09-06", bookingRangeDays: 7 }), 14, "valid search dates must override a stale explicit day count");
assert.equal(bookingPeriodDays({ bookingRangeDays: 9 }), 9, "explicit days remain a fallback when dates are absent");
assert.equal(bookingPeriodDays({ checkIn: "2026-08-10", checkOut: "2026-08-04", bookingRangeDays: 7 }), null, "reversed dates must not claim a false period");
assert.equal(bookingPeriodDays({ checkIn: "invalid", checkOut: "2026-08-04", bookingRangeDays: 7 }), null, "invalid date input must not fall back to a misleading period");

uiContext.state.data.run = {
  checkIn: "2026-08-24",
  checkOut: "2026-09-06",
  bookingRangeDays: 7
};
const currentRangeRow = {
  company: { currentItem: { weeklyDays: 14 } },
  metrics: { revenueImpact: { lodging: { basis: "range" } } }
};
assert.deepEqual(
  JSON.parse(JSON.stringify(uiContext.adminDbRevenuePeriodProfile(currentRangeRow))),
  {
    days: 14,
    requestedDays: 14,
    observedDays: 14,
    label: "14일 매출",
    expectedLabel: "예상 14일 매출",
    coverageLabel: "14일 검색기간 기준"
  }
);

const partialRangeRow = {
  company: { currentItem: { weeklyDays: 7 } },
  metrics: { revenueImpact: { lodging: { basis: "range" } } }
};
const partialProfile = uiContext.adminDbRevenuePeriodProfile(partialRangeRow);
assert.equal(partialProfile.label, "14일 매출");
assert.equal(partialProfile.coverageLabel, "14일 검색 · 7/14일 확보", "partial collection must remain visible instead of rescaling revenue");

const storedNineDayRow = {
  company: {},
  metrics: {
    signal: { lodgingDays: 9 },
    revenueImpact: { lodging: { basis: "range" } }
  }
};
assert.equal(uiContext.adminDbRevenuePeriodProfile(storedNineDayRow).label, "9일 매출", "stored master rows must use observed provenance rather than the active search");
assert.equal(
  uiContext.adminDbRevenuePeriodProfile({ company: {}, metrics: { revenueImpact: { lodging: { basis: "basis" } } } }).label,
  "1일 매출"
);
assert.equal(
  uiContext.adminDbRevenuePeriodProfile({ company: {}, metrics: { revenueImpact: {} } }).label,
  "검색기간 매출",
  "legacy rows without period evidence must use a neutral label"
);

const samePeriodAverage = uiContext.adminDbAverageRevenuePeriodProfile([storedNineDayRow, storedNineDayRow]);
assert.equal(samePeriodAverage.label, "평균 9일 매출");
const mixedPeriodAverage = uiContext.adminDbAverageRevenuePeriodProfile([
  storedNineDayRow,
  { company: {}, metrics: { signal: { lodgingDays: 7 }, revenueImpact: { lodging: { basis: "range" } } } }
]);
assert.equal(mixedPeriodAverage.label, "평균 검색기간 매출");
assert.match(mixedPeriodAverage.note, /기간 혼합/);

for (const name of [
  "adminDbB2BMetricCards",
  "adminDbSelectedAppliedCards",
  "adminDbSelectedKpiCardsHtml",
  "adminDbCompanyRow",
  "adminDbListPreviewPanel",
  "renderAdminDatabaseDashboard"
]) {
  assert.doesNotMatch(functionBlock(app, name), /(?:예상 |평균 )?7일 매출/, `${name} must not hardcode a seven-day revenue label`);
}
assert.match(functionBlock(app, "adminDbCompanyRow"), /adminDbRevenuePeriodProfile\(row\)/);
assert.match(functionBlock(app, "adminDbListPreviewPanel"), /adminDbRevenuePeriodProfile\(row\)/);
assert.match(functionBlock(app, "adminDbSelectedKpiCardsHtml"), /pick\.has\(card\.key\)/, "KPI selection must not depend on a translated period label");
assert.match(functionBlock(app, "b2bLiveSearchPayload"), /bookingDays\(\{ checkIn, checkOut, bookingRangeDays: DEFAULT_BOOKING_DAYS \}\)/);
assert.match(functionBlock(app, "collectB2BMyLodgeByName"), /bookingDays\(\{ checkIn, checkOut, bookingRangeDays: DEFAULT_BOOKING_DAYS \}\)/);

const serverContext = vm.createContext({ Number, Date });
for (const name of ["dateDiffDays", "isoDateAddDays", "bookingDaysFromRange"]) {
  vm.runInContext(functionSource(server, name), serverContext);
}
assert.equal(serverContext.bookingDaysFromRange("2026-08-04", "2026-08-04"), 1);
assert.equal(serverContext.bookingDaysFromRange("2026-08-04", "2026-08-05"), 2);
assert.equal(serverContext.bookingDaysFromRange("2026-08-24", "2026-09-06"), 14);
assert.equal(serverContext.bookingDaysFromRange("2026-08-10", "2026-08-04"), 0);
assert.equal(serverContext.bookingDaysFromRange("invalid", "2026-08-04"), 0);
assert.equal(serverContext.isoDateAddDays("2026-08-30", 7), "2026-09-06");
assert.match(functionBlock(server, "crawlExecutionPlan"), /bookingDaysFromRange\(checkIn, checkOut\) \|\| requestedBookingDays/);
assert.match(functionBlock(server, "b2bSearchPayload"), /bookingDaysFromRange\(checkIn, checkOut\) \|\| fallbackBookingRangeDays/);
assert.match(functionBlock(server, "b2bMyLodgePayload"), /bookingDaysFromRange\(checkIn, checkOut\) \|\| fallbackBookingRangeDays/);

console.log("Search-period revenue label and collection duration contract checks passed");
