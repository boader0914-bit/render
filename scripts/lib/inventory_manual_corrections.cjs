"use strict";

const FIELDS = new Set(["bizItemId", "stayDate", "observedStock", "correctedStock", "reason"]);
const MAX_STOCK = 10000;

function invalidCorrection() {
  return Object.assign(new Error("상품 재고 보정에는 상품 번호, 숙박일, 관측 수량, 확인 수량과 확인 사유가 필요합니다. 같은 상품과 날짜는 한 번만 입력해 주세요."), {
    statusCode: 400, code: "INVALID_PRODUCT_STOCK_CORRECTION"
  });
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

// A saved correction is evidence for one product and stay date, never a global
// stock cap. Reject typos and duplicate rules instead of silently choosing one.
function sanitizeProductStockCorrections(value = []) {
  if (!Array.isArray(value) || value.length > 366) throw invalidCorrection();
  const seen = new Set();
  const result = value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some((key) => !FIELDS.has(key))) throw invalidCorrection();
    const bizItemId = typeof row.bizItemId === "string" ? row.bizItemId.trim() : "";
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(bizItemId) || !validDate(row.stayDate)
      || !reason || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)
      || ![row.observedStock, row.correctedStock].every((stock) => Number.isSafeInteger(stock) && stock > 0 && stock <= MAX_STOCK)
      || row.observedStock === row.correctedStock) throw invalidCorrection();
    const key = `${bizItemId}|${row.stayDate}`;
    if (seen.has(key)) throw invalidCorrection();
    seen.add(key);
    return { bizItemId, stayDate: row.stayDate, observedStock: row.observedStock, correctedStock: row.correctedStock, reason };
  });
  return result.sort((left, right) => left.stayDate.localeCompare(right.stayDate) || left.bizItemId.localeCompare(right.bizItemId));
}

function observedNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function applyProductStockCorrections(rows, value, isEligible = () => true) {
  const corrections = sanitizeProductStockCorrections(value);
  if (!corrections.length) return { rows, normalizationEvidence: [] };
  const byKey = new Map(corrections.map((row) => [`${row.bizItemId}|${row.stayDate}`, row]));
  const normalizationEvidence = [];
  const normalized = rows.map((row) => {
    const correction = byKey.get(`${String(row.bizItemId || "")}|${row.date || ""}`);
    const stock = observedNumber(row.stock), bookings = observedNumber(row.bookingCount);
    if (!correction || !isEligible(row) || row.collectionFailed || row.missing
      || stock !== correction.observedStock || bookings === null || bookings < 0) return row;
    normalizationEvidence.push({ date: row.date, productKey: correction.bizItemId,
      reason: "db_reviewed_product_stock_correction", label: "DB 검수 상품 재고 보정",
      reviewReason: correction.reason, source: { stock }, applied: { stock: correction.correctedStock } });
    // Leave every reservation/closure field intact. If bookings exceed the
    // corrected stock, normal inventory conflict handling must still fire.
    return { ...row, stock: correction.correctedStock };
  });
  return { rows: normalized, normalizationEvidence };
}

module.exports = { sanitizeProductStockCorrections, applyProductStockCorrections };
