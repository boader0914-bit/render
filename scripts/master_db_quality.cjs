const { cleanText, numberOrNull, parsePrice } = require("./master_db.cjs");

const COMPANY_CURRENT_MIN_CONFIDENCE_SCORE = 70;
const COMPANY_CURRENT_CONFIDENCE_GRADES = new Set(["A", "B"]);

function validIsoDate(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validateCompanyObservation(observation = {}) {
  const reasons = [];
  const supply = numberOrNull(observation.supply);
  const available = numberOrNull(observation.available);
  const sold = numberOrNull(observation.sold);
  const saleRate = numberOrNull(observation.saleRate);
  const price = parsePrice(observation.price);
  if (!validIsoDate(observation.stayDate)) reasons.push("invalid_stay_date");
  if (!Number.isFinite(Date.parse(observation.collectedAt || ""))) reasons.push("invalid_collected_at");
  for (const [field, value] of [["supply", supply], ["available", available], ["sold", sold]]) {
    if (!Number.isInteger(value) || value < 0) reasons.push(`invalid_${field}`);
  }
  if (Number.isInteger(supply) && supply <= 0) reasons.push("non_positive_supply");
  if (Number.isInteger(supply) && Number.isInteger(available) && available > supply) reasons.push("available_exceeds_supply");
  if (Number.isInteger(supply) && Number.isInteger(sold) && sold > supply) reasons.push("sold_exceeds_supply");
  if ([supply, available, sold].every(Number.isInteger) && sold + available !== supply) reasons.push("inventory_equation_mismatch");
  if (saleRate === null || saleRate < 0 || saleRate > 1) reasons.push("invalid_sale_rate");
  if (Number.isInteger(supply) && supply > 0 && Number.isInteger(sold) && saleRate !== null
    && Math.abs((sold / supply) - saleRate) > 0.011) reasons.push("sale_rate_mismatch");
  if (price === null) reasons.push("price_not_observed");

  const confidenceGrade = cleanText(observation.inventoryConfidenceGrade).toUpperCase();
  const confidenceScore = numberOrNull(observation.inventoryConfidenceScore);
  if (!COMPANY_CURRENT_CONFIDENCE_GRADES.has(confidenceGrade)) reasons.push("confidence_grade_below_current_threshold");
  if (confidenceScore === null || confidenceScore < COMPANY_CURRENT_MIN_CONFIDENCE_SCORE) reasons.push("confidence_score_below_current_threshold");
  const qualityScore = confidenceScore === null ? 0 : Math.max(0, Math.min(1, confidenceScore / 100));
  return {
    status: reasons.length ? "partial" : "complete",
    promoteCurrent: reasons.length === 0,
    qualityScore,
    reasons: [...new Set(reasons)]
  };
}

module.exports = {
  COMPANY_CURRENT_MIN_CONFIDENCE_SCORE,
  COMPANY_CURRENT_CONFIDENCE_GRADES,
  validIsoDate,
  validateCompanyObservation
};
