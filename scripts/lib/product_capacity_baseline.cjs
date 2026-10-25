"use strict";

// Compact witnesses of normal product responses. No prices, inferred totals or
// future observations become historical room-capacity evidence.
const { observedProductCapacityEvidence: normalizedEvidence } = require("../inventory_estimation.cjs");
const crypto = require("node:crypto");
const instant = value => typeof value === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
function observedProductCapacityEvidence(item, company, { runId = "", collectedAt = "", verifiedDates = null, source = "normal_saved_product_response" } = {}) {
  const observedAt = instant(collectedAt);
  if (!observedAt || !company?.companyId) return [];
  const baseline = { ...(item.inventoryCapacityBaseline || {}) };
  const correction = company.manualCorrection;
  if (correction && correction.active !== false) {
    baseline.productStockCorrections = correction.productStockCorrections || [];
    if (Number(correction.lodgingBasisTotal) > 0) baseline.lodgingOverride = { count: Number(correction.lodgingBasisTotal) };
  }
  const rows = normalizedEvidence(item, baseline).products, maxima = new Map();
  for (const product of rows) {
    const row = product, productId = String(product.bizItemId || "");
    const kind = product.kind === "dayUse" ? "dayuse" : product.kind;
    if (!productId || !["lodging", "dayuse"].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) continue;
    if (verifiedDates && !(verifiedDates[kind] || []).includes(row.date)) continue;
    const stock = Number(product.stock);
    if (!product.observed || !product.stockObserved || product.inventoryConflict || !Number.isSafeInteger(stock) || stock <= 0) continue;
    const key = `${kind}|${productId}`;
    const old = maxima.get(key);
    if (!old || stock > old.count) maxima.set(key, { companyId: company.companyId, productId, productType: kind,
      count: stock, collectedAt: observedAt, sourceDate: row.date, runId: String(runId), source });
  }
  return [...maxima.values()];
}
function baselineAtBoundary(evidence, companyId, boundary) {
  const lodgingProducts = {}, dayUseProducts = {};
  if (!boundary) return { lodgingProducts, dayUseProducts };
  for (const row of Array.isArray(evidence) ? evidence : []) {
    if (row?.companyId !== companyId) continue;
    const observedAt = instant(row?.collectedAt), count = Number(row?.count), id = String(row?.productId || "");
    if (!observedAt || observedAt > boundary || !id || !Number.isSafeInteger(count) || count <= 0) continue;
    const target = row.productType === "lodging" ? lodgingProducts : row.productType === "dayuse" ? dayUseProducts : null;
    if (target && (!target[id] || count > target[id].count)) target[id] = { count, source: row.source || "historical_product_maximum",
      sourceDate: row.sourceDate || "", collectedAt: observedAt, observedAt, runId: row.runId || "" };
  }
  return { lodgingProducts, dayUseProducts };
}
function productCapacityBaselineAt(evidence, companyId, asOf) {
  return baselineAtBoundary(evidence, companyId, instant(asOf));
}
function compactProductCapacityEvidence(evidence) {
  const maxima = new Map(), result = [];
  for (const row of [...(evidence || [])].filter(row => instant(row?.collectedAt)).sort((a, b) => a.collectedAt.localeCompare(b.collectedAt)
    || String(a.runId || "").localeCompare(String(b.runId || "")))) {
    const key = `${row.companyId}|${row.productType}|${row.productId}`;
    if (Number.isSafeInteger(row.count) && row.count > (maxima.get(key) || 0)) { maxima.set(key, row.count); result.push(row); }
  }
  return result;
}
function mergeProductCapacityBaselines(...inputs) {
  const selected = new Map();
  for (const input of inputs) for (const [id, value] of Object.entries(input || {})) {
    const count = Number(value && typeof value === "object" ? value.count ?? value.capacity : value);
    if (!id || !Number.isSafeInteger(count) || count <= 0) continue;
    const prior = selected.get(id), priorCount = Number(prior && typeof prior === "object" ? prior.count ?? prior.capacity : prior);
    if (!selected.has(id) || count > priorCount) selected.set(id, value && typeof value === "object" ? { ...value, count } : count);
  }
  return Object.fromEntries(selected);
}
function productCapacityEvidenceRevision(evidence, companyIds, asOf, warnings = []) {
  const ids = [...new Set(companyIds || [])].sort();
  const selected = new Set(ids), grouped = new Map(), boundary = instant(asOf);
  // Preserve witness order and equal-count winners while normalizing only the
  // selected company's rows once, rather than all witnesses for every company.
  if (boundary) for (const row of Array.isArray(evidence) ? evidence : []) {
    const id = row?.companyId; if (!selected.has(id)) continue;
    let rows = grouped.get(id); if (!rows) grouped.set(id, rows = []); rows.push(row);
  }
  const projected = ids.map(id => [id, baselineAtBoundary(grouped.get(id), id, boundary)]);
  const relevantWarnings = warnings.filter(row => selected.has(row.companyId)).map(row => [row.companyId, row.code]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash("sha256").update(JSON.stringify([projected, relevantWarnings])).digest("hex");
}
function withProductCapacityBaseline(item, company, evidence, asOf) {
  return { ...item, inventoryObservedAt: instant(asOf), inventoryCapacityBaseline: { ...(item.inventoryCapacityBaseline || {}),
    ...productCapacityBaselineAt(evidence, company.companyId, asOf) } };
}
module.exports = { observedProductCapacityEvidence, productCapacityBaselineAt, withProductCapacityBaseline, compactProductCapacityEvidence,
  mergeProductCapacityBaselines, productCapacityEvidenceRevision };
