"use strict";

// Zero (including the omitted default) means all products. A positive integer
// remains available for coverage diagnostics of legacy limited observations.
// Current lodging and day-use collection both use the unlimited default.
function selectProductTargets(items, limit = 0) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("INVALID_PRODUCT_LIMIT");
  const seen = new Set();
  const unique = (Array.isArray(items) ? items : []).filter(item => {
    const id = String(item?.bizItemId ?? "").trim();
    // Keep malformed entries visible to validation instead of hiding them.
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return limit === 0 ? unique : unique.slice(0, limit);
}

function createProductCoverage() {
  const businesses = new Map();
  function discover(businessId, all, eligible, dates = [], metadata = {}) {
    all = selectProductTargets(all);
    eligible = selectProductTargets(eligible);
    const key = String(businessId);
    if (!businesses.has(key)) businesses.set(key, {
      businessId: key, discovered: all.length, eligible: eligible.length,
      excluded: all.length - eligible.length, expectedDates: [...dates],
      queriedIds: new Set(), truncatedIds: new Set(), days: new Map(), metadata
    });
  }
  function record(businessId, items, limit, date, rows) {
    const state = businesses.get(String(businessId));
    if (!state) return;
    items = selectProductTargets(items);
    const selected = selectProductTargets(items, limit);
    const groups = state.days.get(date) || new Map();
    const day = { date, eligible: items.length, queried: 0, succeeded: 0, failed: 0, truncated: 0 };
    const attempted = selectProductTargets(rows.filter(row => row.queryAttempted !== false));
    day.queried += attempted.length;
    day.truncated += items.length - selected.length;
    const succeeded = attempted.filter(row => !row.collectionFailed && row.stock !== null && row.stock !== undefined
      && Number.isFinite(Number(row.stock)) && !(Array.isArray(row.errors) ? row.errors.length : row.errors)).length;
    day.succeeded += succeeded;
    day.failed += attempted.length - succeeded;
    for (const item of attempted) state.queriedIds.add(String(item.bizItemId));
    for (const item of items.slice(selected.length)) state.truncatedIds.add(String(item.bizItemId));
    groups.set(JSON.stringify(items.map(item => String(item.bizItemId)).sort()), day);
    state.days.set(date, groups);
  }
  function snapshot() {
    const targets = [...businesses.values()].map(state => ({
      businessId: state.businessId, discovered: state.discovered, eligible: state.eligible,
      excluded: state.excluded, queried: state.queriedIds.size, truncated: state.truncatedIds.size,
      ...state.metadata,
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

module.exports = { createProductCoverage, selectProductTargets };
