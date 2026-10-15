"use strict";

const crypto = require("node:crypto");
const { SOURCE } = require("./special_days.cjs");

const DAY = 86400000;
const VERSION = "regional-outlook-calendar-v1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dateText = value => new Date(value).toISOString().slice(0, 10);
const timestamp = date => Date.parse(`${date}T00:00:00Z`);
const isWeekend = value => [0, 6].includes(new Date(value).getUTCDay());
function normalizePeriods(values) {
  if (!Array.isArray(values) || values.length > 120) throw Object.assign(new Error("Invalid calendar periods"), { code: "INVALID_OUTLOOK_PERIODS" });
  return [...new Set(values.map(value => {
    const period = String(value);
    if (!/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(period)) throw Object.assign(new Error("Invalid calendar period"), { code: "INVALID_OUTLOOK_PERIODS" });
    return period;
  }))].sort();
}
function monthBounds(period) {
  const start = timestamp(`${period}-01`), date = new Date(start);
  return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0) };
}
function requiredRegionalOutlookYears(periods) {
  const years = new Set();
  for (const period of normalizePeriods(periods)) {
    const year = Number(period.slice(0, 4)), month = Number(period.slice(5));
    years.add(year);
    if (month === 1 && year > 2000) years.add(year - 1);
    if (month === 12 && year < 2100) years.add(year + 1);
  }
  return [...years].sort((a, b) => a - b);
}
function normalizeYear(result, year) {
  const category = result?.year === year ? result.categories?.holidays : null;
  const successful = Boolean(category && ["ready", "stale"].includes(category.status) && Number.isFinite(Date.parse(category.updatedAt)) && Array.isArray(category.items));
  const malformed = successful && category.items.some(item => {
    if (!item || typeof item !== "object" || ![true, false].includes(item.isHoliday) || typeof item.name !== "string" || !item.name.trim() || !new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(item.date)) return true;
    const time = timestamp(item.date);
    return !Number.isFinite(time) || dateText(time) !== item.date;
  });
  const known = successful && !malformed;
  const holidays = new Map();
  if (known) for (const item of category.items) {
    // Only the official rest-day operation and its actual Y rows count. Never
    // merge anniversaries/national-day entries into public holidays.
    if (item?.isHoliday !== true || (item.kind && item.kind !== "holidays") || !new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(item.date)) continue;
    const time = timestamp(item.date);
    if (!Number.isFinite(time) || dateText(time) !== item.date) continue;
    const names = holidays.get(item.date) || new Set();
    if (typeof item.name === "string" && item.name.trim()) names.add(item.name.trim());
    holidays.set(item.date, names);
  }
  return { year, known, stale: Boolean(known && category.stale), updatedAt: known ? category.updatedAt : null,
    errorCode: malformed ? "INVALID_CALENDAR_CACHE" : !known ? category?.error?.code || "NOT_COLLECTED" : category.error?.code || null,
    holidays: [...holidays].map(([date, names]) => ({ date, names: [...names].sort() })).sort((a, b) => a.date.localeCompare(b.date)) };
}

function buildRegionalOutlookCalendar({ periods = [], years = [] } = {}) {
  periods = normalizePeriods(periods);
  if (!Array.isArray(years)) throw Object.assign(new Error("Invalid calendar years"), { code: "INVALID_OUTLOOK_CALENDAR" });
  const requiredYears = requiredRegionalOutlookYears(periods);
  const byYear = new Map(requiredYears.map(year => {
    // Conflicting duplicate year payloads cannot silently determine a calendar.
    const matching = years.filter(value => value?.year === year);
    return [year, normalizeYear(matching.length === 1 ? matching[0] : null, year)];
  }));
  const dateState = time => {
    const date = dateText(time), year = byYear.get(new Date(time).getUTCFullYear());
    const names = year?.holidays.find(item => item.date === date)?.names || [];
    return { date, weekend: isWeekend(time), official: Boolean(year?.known && year.holidays.some(item => item.date === date)), names,
      known: Boolean(year?.known), off: isWeekend(time) || Boolean(year?.known && year.holidays.some(item => item.date === date)) };
  };
  const months = periods.map(period => {
    const { start, end } = monthBounds(period), year = byYear.get(Number(period.slice(0, 4)));
    const monthYears = requiredRegionalOutlookYears([period]).map(value => byYear.get(value));
    const ownKnown = Boolean(year?.known);
    const coverageComplete = ownKnown && monthYears.every(value => value?.known);
    const allDays = [];
    for (let time = start; time <= end; time += DAY) allDays.push(dateState(time));
    const holidays = (year?.holidays || []).filter(item => item.date.startsWith(period));
    const holidayEveDates = [], bridgeCandidateDates = [];
    for (let time = start; time <= end; time += DAY) {
      const day = dateState(time), previous = dateState(time - DAY), next = dateState(time + DAY);
      if (next.known && next.official) holidayEveDates.push(day.date);
      if (day.known && !day.off && previous.known && next.known && previous.off && next.off) bridgeCandidateDates.push(day.date);
    }
    const longBreaks = [];
    // Walk each relevant continuous weekend/official holiday run to its real
    // boundaries, including month/year transitions. Unknown weekdays end a
    // verified run but mark it incomplete; no invented bridge holidays.
    for (let time = start; time <= end; time += DAY) {
      if (!dateState(time).off) continue;
      let from = time, to = time;
      while (dateState(from - DAY).off && time - from < 370 * DAY) from -= DAY;
      while (dateState(to + DAY).off && to - time < 370 * DAY) to += DAY;
      const days = Math.round((to - from) / DAY) + 1;
      const runDays = [];
      for (let at = from; at <= to; at += DAY) runDays.push(dateState(at));
      const boundaryComplete = dateState(from - DAY).known && dateState(to + DAY).known && runDays.every(day => day.known);
      if (days >= 3) longBreaks.push({ start: dateText(from), end: dateText(to), days,
        overlapDays: Math.round((Math.min(end, to) - Math.max(start, from)) / DAY) + 1,
        officialHolidayDates: runDays.filter(day => day.official).map(day => day.date), names: [...new Set(runDays.flatMap(day => day.names))].sort(), boundaryComplete });
      time = to;
    }
    const boundaryKnown = coverageComplete && longBreaks.every(run => run.boundaryComplete);
    const sourceFingerprint = hash({ version: VERSION, period, years: monthYears.map(value => ({ year: value?.year || null, known: Boolean(value?.known), holidays: value?.holidays || [] })) });
    return { period, status: !ownKnown ? "missing" : boundaryKnown ? "ready" : "partial",
      daysInMonth: allDays.length, weekendDays: allDays.filter(day => day.weekend).length,
      holidayDates: holidays.map(item => item.date), holidays, holidayDays: ownKnown ? holidays.length : null,
      holidayOrWeekendDays: ownKnown ? allDays.filter(day => day.off).length : null,
      longBreaks, longBreakDays: boundaryKnown ? longBreaks.reduce((sum, run) => sum + run.overlapDays, 0) : null,
      longestRunDays: boundaryKnown ? Math.max(0, ...longBreaks.map(run => run.days)) : null,
      holidayEveDates, bridgeCandidateDates, bridgeCandidatesAreOfficialHolidays: false,
      coverageComplete: boundaryKnown, knownDays: ownKnown ? allDays.length : 0,
      stale: monthYears.some(value => value?.stale), updatedAt: monthYears.map(value => value?.updatedAt).filter(Boolean).sort()[0] || null,
      errorCode: !ownKnown ? year?.errorCode || "NOT_COLLECTED" : boundaryKnown ? null : "CALENDAR_BOUNDARY_MISSING", sourceFingerprint };
  });
  return { version: VERSION, status: months.length && months.every(month => month.status === "ready") ? "ready" : months.some(month => month.status !== "missing") ? "partial" : "missing",
    source: { ...SOURCE, operation: "getRestDeInfo", holidayRule: "isHoliday=Y" }, cacheOnly: true, networkAttempted: false,
    requiredYears, missingYears: [...byYear.values()].filter(year => !year.known).map(year => year.year),
    staleYears: [...byYear.values()].filter(year => year.stale).map(year => year.year),
    years: [...byYear.values()].map(({ holidays, ...value }) => ({ ...value, holidayDays: value.known ? holidays.length : null })),
    months, sourceFingerprint: hash({ version: VERSION, months: months.map(month => [month.period, month.sourceFingerprint]) }) };
}

async function loadRegionalOutlookCalendar({ specialDays, periods = [] } = {}) {
  const years = [];
  for (const year of requiredRegionalOutlookYears(periods)) {
    try {
      // No fallback to getYear: it can refresh expired data and violate a read.
      if (typeof specialDays?.getCachedYear === "function") years.push(await specialDays.getCachedYear(year));
    } catch { /* Missing/failed stored years remain explicitly unknown. */ }
  }
  return buildRegionalOutlookCalendar({ periods, years });
}

module.exports = { VERSION, requiredRegionalOutlookYears, buildRegionalOutlookCalendar, loadRegionalOutlookCalendar };
