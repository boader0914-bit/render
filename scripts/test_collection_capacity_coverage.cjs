"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { collectionCapacityCoverageForBusiness } = require("./lib/collection_capacity_coverage.cjs");

test("room review receives only the exact company's saved product coverage", () => {
  const source = { targets: [
    { businessId: "1680978", eligible: 62, queried: 40, truncated: 22, productListComplete: true,
      expectedDays: 1, days: [{ date: "2026-09-27", eligible: 62, queried: 40, succeeded: 40, failed: 0, truncated: 22 }] },
    { businessId: "696299", eligible: 61, queried: 61, truncated: 0, productListComplete: true }
  ] };
  const before = JSON.stringify(source);
  const limited = collectionCapacityCoverageForBusiness(source, "1680978");
  assert.equal(limited.truncated, 22);
  assert.equal(limited.days[0].failed, 0);
  assert.equal(collectionCapacityCoverageForBusiness(source, "696299").truncated, 0);
  assert.equal(collectionCapacityCoverageForBusiness(source, "missing"), null);
  assert.equal(collectionCapacityCoverageForBusiness(source, "123"), null);
  assert.equal(JSON.stringify(source), before);
});

test("missing and malformed receipt counts remain unknown, not successful zero", () => {
  const result = collectionCapacityCoverageForBusiness({ targets: [{ businessId: "1", queried: null,
    eligible: "", truncated: -1, productListComplete: "true", token: "not-a-presentation-field",
    days: [{ date: "2026-09-27", failed: false }, { date: "bad", queried: 1 }] }] }, "1");
  assert.equal(result.eligible, null);
  assert.equal(result.queried, null);
  assert.equal(result.truncated, null);
  assert.equal(result.productListComplete, null);
  assert.equal(result.days[0].failed, null);
  assert.equal(result.days.length, 1);
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(collectionCapacityCoverageForBusiness({ targets: [{ businessId: "1" }, { businessId: "1" }] }, "1"), null);
});
