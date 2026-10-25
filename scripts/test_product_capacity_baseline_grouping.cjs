"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), { performance } = require("node:perf_hooks");
const { productCapacityBaselineAt, productCapacityEvidenceRevision, withProductCapacityBaseline } = require("./lib/product_capacity_baseline.cjs");

// Deliberately retained pre-optimization oracle. Insertion order, strict company
// identity, original equal-count winner and the complete hash must stay exact.
const instant = value => typeof value === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
function baselineOracle(evidence, companyId, asOf) {
  const boundary = instant(asOf), lodgingProducts = {}, dayUseProducts = {};
  if (!boundary) return { lodgingProducts, dayUseProducts };
  for (const row of Array.isArray(evidence) ? evidence : []) {
    const observedAt = instant(row?.collectedAt), count = Number(row?.count), id = String(row?.productId || "");
    if (row?.companyId !== companyId || !observedAt || observedAt > boundary || !id || !Number.isSafeInteger(count) || count <= 0) continue;
    const target = row.productType === "lodging" ? lodgingProducts : row.productType === "dayuse" ? dayUseProducts : null;
    if (target && (!target[id] || count > target[id].count)) target[id] = { count, source: row.source || "historical_product_maximum", sourceDate: row.sourceDate || "", collectedAt: observedAt, observedAt, runId: row.runId || "" };
  }
  return { lodgingProducts, dayUseProducts };
}
function revisionOracle(evidence, companyIds, asOf, warnings = []) {
  const ids = [...new Set(companyIds || [])].sort(), projected = ids.map(id => [id, baselineOracle(evidence, id, asOf)]);
  const relevantWarnings = warnings.filter(row => ids.includes(row.companyId)).map(row => [row.companyId, row.code]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash("sha256").update(JSON.stringify([projected, relevantWarnings])).digest("hex");
}
const row = (companyId, count, extra = {}) => ({ companyId, count, productId: "room", productType: "lodging", collectedAt: "2026-09-10T00:00:00Z", sourceDate: "2026-09-11", runId: "r1", ...extra });

test("grouping retains exact baseline objects and digest for duplicate IDs, ties, temporal limits and warning order", () => {
  const values = [row("a", 10), row("b", 7), row("a", 10, { source: "later-equal", runId: "r2" }), row("a", 12, { productId: "another", collectedAt: "2026-09-11T09:00:00+09:00" }),
    row("a", 20, { collectedAt: "2026-10-01T00:00:00Z" }), row("a", 3, { productType: "dayuse", productId: "lunch" }), row("a", 4, { productId: "__proto__" }),
    row("a", "9", { productId: "10" }), row("a", 2, { productId: "2" }), row("a", 0), row("a", 1.5), row("a", NaN), row("a", 8, { collectedAt: "invalid" }),
    row(0, 2), row(NaN, 3), null, row("unselected", 80)];
  const warnings = [{ companyId: "b", code: "Z" }, { companyId: "a", code: "A" }, { companyId: "a", code: "A" }, { companyId: "unselected", code: "EXCLUDED" }, { companyId: NaN, code: "NAN" }];
  const ids = ["b", "a", "b", 0, NaN, "absent"];
  for (const cutoff of ["2026-09-30T23:59:59+09:00", "2026-09-10T00:00:00Z", "invalid", "2026-09-30"]) {
    for (const id of ids) assert.deepEqual(productCapacityBaselineAt(values, id, cutoff), baselineOracle(values, id, cutoff));
    assert.equal(productCapacityEvidenceRevision(values, ids, cutoff, warnings), revisionOracle(values, ids, cutoff, warnings));
  }
  const item = { inventoryCapacityBaseline: { lodgingOverride: { count: 16 } }, marker: "unchanged" }, before = JSON.stringify(values);
  assert.deepEqual(withProductCapacityBaseline(item, { companyId: "a" }, values, "2026-09-30T00:00:00Z"), { ...item, inventoryObservedAt: "2026-09-30T00:00:00.000Z", inventoryCapacityBaseline: { ...item.inventoryCapacityBaseline, ...baselineOracle(values, "a", "2026-09-30T00:00:00Z") } });
  assert.equal(JSON.stringify(values), before, "grouping cannot mutate original witnesses");
});

test("seeded mixed witness order and malformed values remain byte-for-byte hash equivalent", () => {
  let seed = 425; const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const companyIds = ["a", "b", "c", "z"], counts = [0, -1, 1, 2, 2, 16, "7", undefined, 1.2, NaN], dates = ["2026-09-01T00:00:00Z", "2026-09-20T12:00:00+09:00", "2026-10-01T00:00:00Z", "invalid", null];
  for (let sample = 0; sample < 120; sample++) {
    const values = Array.from({ length: 80 }, () => row(companyIds[random(4)], counts[random(counts.length)], { productId: ["1", "3", "room", "lunch", ""][random(5)], productType: ["lodging", "dayuse", "other"][random(3)], collectedAt: dates[random(dates.length)], runId: "r" + random(8), source: random(2) ? "original" : "", sourceDate: random(2) ? "2026-09-12" : "" }));
    const ids = [companyIds[random(4)], companyIds[random(4)], "a"], warnings = Array.from({ length: 8 }, () => ({ companyId: companyIds[random(4)], code: "warning-" + random(3) }));
    assert.equal(productCapacityEvidenceRevision(values, ids, "2026-09-30T23:59:59+09:00", warnings), revisionOracle(values, ids, "2026-09-30T23:59:59+09:00", warnings));
  }
});

test("an industry revision normalizes each relevant witness once rather than once per company", t => {
  const ids = Array.from({ length: 400 }, (_, index) => "company-" + index), values = ids.flatMap(companyId => Array.from({ length: 20 }, (_, n) => ({ companyId, productType: n % 2 ? "dayuse" : "lodging", productId: "p" + n % 4, count: n + 1, collectedAt: "2026-09-" + String(n + 1).padStart(2, "0") + "T00:00:00Z", runId: "r" + n })));
  const originalParse = Date.parse; let parses = 0, elapsed, digest;
  try { Date.parse = value => { parses++; return originalParse(value); }; const started = performance.now(); digest = productCapacityEvidenceRevision(values, ids, "2026-09-30T23:59:59+09:00"); elapsed = performance.now() - started; } finally { Date.parse = originalParse; }
  assert.equal(digest, "150c1afc5a034553c8683e4e1463e2bdeb9cd8ddfbf79595d5ae7c0515104632", "matches the independently measured unoptimized oracle");
  assert.equal(parses, values.length + 1); t.diagnostic(JSON.stringify({ companies: ids.length, witnesses: values.length, dateParses: parses, elapsedMs: Math.round(elapsed) }));
});

test("a single-company baseline does not parse unrelated companies or retain a stale index after append", () => {
  const values = Array.from({ length: 10000 }, (_, index) => row("other-" + index, 5)); values.push(row("a", 10));
  const originalParse = Date.parse; let parses = 0;
  try { Date.parse = value => { parses++; return originalParse(value); }; assert.equal(productCapacityBaselineAt(values, "a", "2026-09-30T00:00:00Z").lodgingProducts.room.count, 10); } finally { Date.parse = originalParse; }
  assert.equal(parses, 2); values.push(row("a", 16)); assert.equal(productCapacityBaselineAt(values, "a", "2026-09-30T00:00:00Z").lodgingProducts.room.count, 16);
});
