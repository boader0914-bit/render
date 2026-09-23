"use strict";

function createProductCoverage() {
  const businesses = new Map();
  function discover(businessId, all, eligible, dates = []) {
    const key = String(businessId);
    if (!businesses.has(key)) businesses.set(key, {
      businessId: key, discovered: all.length, eligible: eligible.length,
      excluded: all.length - eligible.length, expectedDates: [...dates],
      queriedIds: new Set(), truncatedIds: new Set(), days: new Map()
    });
  }
  function record(businessId, items, limit, date, rows) {
    const state = businesses.get(String(businessId));
    if (!state) return;
    const selected = items.slice(0, limit);
    const groups = state.days.get(date) || new Map();
    const day = { date, eligible: items.length, queried: 0, succeeded: 0, failed: 0, truncated: 0 };
    const attempted = rows.filter(row => row.queryAttempted !== false);
    day.queried += attempted.length;
    day.truncated += items.length - selected.length;
    const succeeded = rows.filter(row => !row.collectionFailed && row.stock !== null && row.stock !== undefined
      && Number.isFinite(Number(row.stock)) && !(Array.isArray(row.errors) ? row.errors.length : row.errors)).length;
    day.succeeded += succeeded;
    day.failed += attempted.length - succeeded;
    for (const item of attempted) state.queriedIds.add(String(item.bizItemId));
    for (const item of items.slice(limit)) state.truncatedIds.add(String(item.bizItemId));
    groups.set(JSON.stringify(items.map(item => String(item.bizItemId)).sort()), day);
    state.days.set(date, groups);
  }
  function snapshot() {
    const targets = [...businesses.values()].map(state => ({
      businessId: state.businessId, discovered: state.discovered, eligible: state.eligible,
      excluded: state.excluded, queried: state.queriedIds.size, truncated: state.truncatedIds.size,
      expectedDays: state.expectedDates.length,
      days: state.expectedDates.map(date => {
        const groups = state.days.get(date);
        if (!groups) return { date, eligible: state.eligible, queried: 0, succeeded: 0, failed: 0, truncated: 0 };
        return [...groups.values()].reduce((sum, group) => {
          for (const key of ["eligible", "queried", "succeeded", "failed", "truncated"]) sum[key] += group[key];
          return sum;
        }, { date, eligible: 0, queried: 0, succeeded: 0, failed: 0, truncated: 0 });
      }),
    }));
    return { version: 1, targets, ...Object.fromEntries(["discovered", "eligible", "excluded", "queried", "truncated"]
      .map(key => [key, targets.reduce((sum, target) => sum + target[key], 0)])) };
  }
  return { discover, record, snapshot };
}

module.exports = { createProductCoverage };
