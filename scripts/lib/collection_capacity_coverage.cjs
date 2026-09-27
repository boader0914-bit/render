"use strict";

// Read-only, company-specific evidence from a saved collection receipt. A
// keyword-wide partial result must not mark every company's room count unsafe.
function collectionCapacityCoverageForBusiness(coverage, businessId) {
  const id = String(businessId || "").trim();
  if (!/^\d+$/.test(id) || !Array.isArray(coverage?.targets)) return null;
  const matches = coverage.targets.filter(target => target && String(target.businessId) === id);
  if (matches.length !== 1) return null;
  const target = matches[0];
  const count = value => (typeof value === "number" || typeof value === "string")
    && String(value).trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
  return {
    businessId: id,
    eligible: count(target.eligible), queried: count(target.queried), truncated: count(target.truncated),
    productListComplete: typeof target.productListComplete === "boolean" ? target.productListComplete : null,
    expectedDays: count(target.expectedDays),
    days: (Array.isArray(target.days) ? target.days : []).filter(day => day && /^\d{4}-\d{2}-\d{2}$/.test(day.date || ""))
      .map(day => ({ date: day.date, eligible: count(day.eligible), queried: count(day.queried),
        succeeded: count(day.succeeded), failed: count(day.failed), truncated: count(day.truncated) }))
  };
}

module.exports = { collectionCapacityCoverageForBusiness };
