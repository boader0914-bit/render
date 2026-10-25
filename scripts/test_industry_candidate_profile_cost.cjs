"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { witnessInputsMatch } = require("./lib/industry_source_candidate_cache.cjs");

test("candidate verification indexes temporal evidence once instead of rescanning all companies for each company", () => {
  const companyIds = Array.from({ length: 400 }, (_, index) => `company-${index}`);
  const evidence = companyIds.flatMap(companyId => Array.from({ length: 20 }, (_, index) => ({ companyId,
    productType: "lodging", productId: `room-${index}`, count: index + 1, collectedAt: "2026-09-20T00:00:00.000Z",
    sourceDate: "2026-09-25", runId: "run-1", source: "normal_saved_product_response" })));
  let rowVisits = 0;
  const indexedEvidence = new Proxy(evidence, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) rowVisits++;
    return Reflect.get(target, key, receiver);
  } });
  const originalParse = Date.parse; let parses = 0;
  Date.parse = function (value) { parses++; return originalParse(value); };
  try {
    assert.equal(witnessInputsMatch({ companyIds, evidence: indexedEvidence, warnings: [] }, indexedEvidence, { evidence: indexedEvidence, warnings: [] }, "2026-09-30"), true);
    assert.ok(rowVisits < evidence.length * 20, `temporal validation revisited source arrays ${rowVisits} times for ${evidence.length} evidence rows`);
    assert.ok(parses < evidence.length * 100, `temporal validation repeated ${parses} date parses for ${evidence.length} evidence rows`);
  } finally { Date.parse = originalParse; }
});
