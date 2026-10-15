"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSpecialDaysService } = require("./lib/special_days.cjs");
const { requiredRegionalOutlookYears, buildRegionalOutlookCalendar, loadRegionalOutlookCalendar } = require("./lib/regional_outlook_calendar.cjs");

function year(year, holidays = [], extra = {}) {
  return { year, categories: { holidays: { status: "ready", updatedAt: "2026-10-16T00:00:00Z", stale: false,
    items: holidays.map(value => typeof value === "string" ? { date: value, name: "공휴일", kind: "holidays", isHoliday: true } : value), ...extra } } };
}
function build(periods, years) { return buildRegionalOutlookCalendar({ periods, years }); }

test("calendar years include cross-year context and reject malformed periods", () => {
  assert.deepEqual(requiredRegionalOutlookYears(["2026-10", "2026-11"]), [2026]);
  assert.deepEqual(requiredRegionalOutlookYears(["2025-01", "2026-12"]), [2024, 2025, 2026, 2027]);
  assert.deepEqual(requiredRegionalOutlookYears(["2000-01", "2100-12"]), [2000, 2100]);
  for (const value of [["2026-13"], ["2026-1"], ["1999-12"], ["2026-10-01"], "2026-10"]) {
    assert.throws(() => requiredRegionalOutlookYears(value), { code: "INVALID_OUTLOOK_PERIODS" });
  }
});

test("only getRestDeInfo Y holidays are counted and overlapping weekend events deduplicate dates", () => {
  const result = year(2026, [
    { date: "2026-10-03", name: "공휴일A", kind: "holidays", isHoliday: true },
    { date: "2026-10-03", name: "공휴일B", kind: "holidays", isHoliday: true },
    { date: "2026-10-05", name: "대체공휴일", kind: "holidays", isHoliday: true },
    { date: "2026-10-09", name: "공휴일 아님", kind: "holidays", isHoliday: false },
    { date: "2026-10-15", name: "기념일", kind: "anniversaries", isHoliday: true }
  ]);
  result.categories.nationalDays = { status: "ready", updatedAt: "2026-10-16T00:00:00Z", items: [{ date: "2026-10-20", isHoliday: true }] };
  const [month] = build(["2026-10"], [result]).months;
  assert.equal(month.status, "ready");
  assert.equal(month.daysInMonth, 31);
  assert.equal(month.weekendDays, 9);
  assert.equal(month.holidayDays, 2);
  assert.equal(month.holidayOrWeekendDays, 10, "Saturday public holiday is not double counted");
  assert.deepEqual(month.holidays[0].names, ["공휴일A", "공휴일B"]);
  assert.deepEqual(month.longBreaks.map(run => [run.start, run.end, run.days]), [["2026-10-03", "2026-10-05", 3]]);
  assert.equal(month.longBreakDays, 3);
});

test("missing calendar stays unknown, while a successful empty year yields real zero holidays", () => {
  const missing = build(["2026-10"], []).months[0];
  const empty = build(["2026-10"], [year(2026)]).months[0];
  assert.equal(missing.status, "missing");
  assert.equal(missing.holidayDays, null);
  assert.equal(missing.holidayOrWeekendDays, null);
  assert.equal(missing.longBreakDays, null);
  assert.equal(missing.weekendDays, 9, "Weekends are independently known");
  assert.equal(empty.status, "ready");
  assert.equal(empty.holidayDays, 0);
  assert.equal(empty.holidayOrWeekendDays, 9);
  assert.equal(empty.longBreakDays, 0);
  assert.notEqual(missing.sourceFingerprint, empty.sourceFingerprint);
});

test("cross-month long break is one real run and only overlaps count in each month", () => {
  const result = build(["2026-04", "2026-05"], [year(2026, ["2026-04-30", "2026-05-01"])]);
  const [april, may] = result.months;
  assert.equal(april.longBreaks.length, 1);
  assert.deepEqual(april.longBreaks[0], { start: "2026-04-30", end: "2026-05-03", days: 4, overlapDays: 1,
    officialHolidayDates: ["2026-04-30", "2026-05-01"], names: ["공휴일"], boundaryComplete: true });
  assert.equal(may.longBreaks[0].overlapDays, 3);
  assert.equal(april.longBreakDays, 1);
  assert.equal(may.longBreakDays, 3);
});

test("cross-year long breaks need both stored calendars; missing next year cannot mean no holidays", () => {
  const complete = build(["2026-12", "2027-01"], [year(2026, ["2026-12-31"]), year(2027, ["2027-01-01"])]);
  assert.equal(complete.status, "ready");
  assert.equal(complete.months[0].longBreakDays, 1);
  assert.equal(complete.months[1].longBreakDays, 3);
  assert.equal(complete.months[1].longBreaks[0].days, 4);
  assert.equal(complete.months[1].longBreaks[0].start, "2026-12-31");
  const partial = build(["2026-12"], [year(2026, ["2026-12-31"])]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.months[0].holidayDays, 1);
  assert.equal(partial.months[0].longBreakDays, null);
  assert.equal(partial.months[0].errorCode, "CALENDAR_BOUNDARY_MISSING");
  assert.deepEqual(partial.missingYears, [2027]);
});

test("bridge weekdays are candidates, never official holidays or an extension of a break", () => {
  const [month] = build(["2026-10"], [year(2026, ["2026-10-01"])]).months;
  assert.deepEqual(month.bridgeCandidateDates, ["2026-10-02"]);
  assert.equal(month.bridgeCandidatesAreOfficialHolidays, false);
  assert.deepEqual(month.holidayDates, ["2026-10-01"]);
  assert.equal(month.longBreakDays, 0);
  assert.equal(month.holidayOrWeekendDays, 10);
  assert.deepEqual(month.holidayEveDates, []);
  const previousMonth = build(["2026-09"], [year(2026, ["2026-10-01"])]).months[0];
  assert.deepEqual(previousMonth.holidayEveDates, ["2026-09-30"]);
});

test("successful stale calendar remains usable and timestamp-only refresh does not change content fingerprint", () => {
  const first = build(["2026-10"], [year(2026, ["2026-10-09"])]);
  const second = build(["2026-10"], [year(2026, ["2026-10-09"], { stale: true, status: "stale", updatedAt: "2026-01-01T00:00:00Z", error: { code: "TIMEOUT" } })]);
  assert.equal(second.status, "ready");
  assert.equal(second.months[0].stale, true);
  assert.equal(second.months[0].holidayDays, 1);
  assert.deepEqual(second.staleYears, [2026]);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.notEqual(first.sourceFingerprint, build(["2026-10"], [year(2026, ["2026-10-09", "2026-10-12"])]).sourceFingerprint);
});

test("a category without a normal successful timestamp cannot manufacture a complete zero calendar", () => {
  const result = build(["2026-10"], [year(2026, [], { status: "error", updatedAt: null, error: { code: "AUTH_ERROR" } })]);
  assert.equal(result.months[0].holidayDays, null);
  assert.equal(result.months[0].errorCode, "AUTH_ERROR");
  assert.equal(build(["2026-10"], [year(2026), year(2026)]).months[0].status, "missing", "Ambiguous duplicate year inputs must be held");
  const malformed = build(["2026-10"], [year(2026, ["2026-10-32"])]).months[0];
  assert.equal(malformed.holidayDays, null);
  assert.equal(malformed.errorCode, "INVALID_CALENDAR_CACHE");
});

test("cache-only loader never falls back to getYear and requests each needed year once", async () => {
  const calls = [];
  const specialDays = { getYear() { throw new Error("network-capable method must not be called"); }, async getCachedYear(value) { calls.push(value); return year(value); } };
  const result = await loadRegionalOutlookCalendar({ specialDays, periods: ["2026-12", "2027-01"] });
  assert.deepEqual(calls, [2026, 2027]);
  assert.equal(result.networkAttempted, false);
  assert.equal(result.status, "ready");
  assert.equal((await loadRegionalOutlookCalendar({ specialDays: { getYear: specialDays.getYear }, periods: ["2026-10"] })).status, "missing");
});

test("special-days cache-only accessor does not resolve key, fetch, rewrite or lose stale stored holidays", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-outlook-calendar-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let keyReads = 0, fetches = 0;
  const service = createSpecialDaysService({ dataDir, readServiceKey() { keyReads++; throw new Error("private key lookup forbidden"); },
    fetchImpl: async () => { fetches++; throw new Error("external network forbidden"); }, now: () => Date.parse("2026-10-16T00:00:00Z") });
  const missing = await service.getCachedYear(2026);
  assert.equal(missing.status, "missing");
  assert.equal(missing.configured, null);
  assert.equal(missing.categories.holidays.status, "missing");
  assert.deepEqual(await fs.readdir(dataDir), []);
  const file = path.join(dataDir, "special-days-2026.json");
  const content = JSON.stringify({ version: 1, year: 2026, categories: { holidays: { updatedAt: "2026-01-01T00:00:00Z", items: [{ date: "2026-10-09", name: "공휴일", kind: "holidays", isHoliday: true }] } } });
  await fs.writeFile(file, content);
  const before = await fs.stat(file);
  const stored = await service.getCachedYear(2026);
  assert.equal(stored.categories.holidays.status, "stale");
  assert.equal(stored.categories.holidays.updatedAt, "2026-01-01T00:00:00Z");
  assert.equal(stored.networkAttempted, false);
  const calendar = await loadRegionalOutlookCalendar({ specialDays: service, periods: ["2026-10"] });
  assert.equal(calendar.months[0].holidayDays, 1);
  assert.equal(calendar.months[0].stale, true);
  assert.equal(await fs.readFile(file, "utf8"), content);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(keyReads, 0);
  assert.equal(fetches, 0);
});

test("leap years and corrupt cache errors preserve distinct calendar coverage", async t => {
  const feb = build(["2024-02"], [year(2024)]).months[0];
  assert.equal(feb.daysInMonth, 29);
  assert.equal(feb.weekendDays, 8);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-outlook-calendar-bad-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "special-days-2026.json"), "not-json");
  const service = createSpecialDaysService({ dataDir, readServiceKey: () => { throw new Error("forbidden"); }, fetchImpl: () => { throw new Error("forbidden"); } });
  const cached = await service.getCachedYear(2026);
  assert.equal(cached.status, "error");
  const result = await loadRegionalOutlookCalendar({ specialDays: service, periods: ["2026-10"] });
  assert.equal(result.months[0].errorCode, "CACHE_READ_ERROR");
  assert.equal(result.months[0].holidayDays, null);
});
