"use strict";

const assert = require("node:assert/strict");
const {
  SCHEMA_VERSION,
  buildAdResponseDiagnostics
} = require("./v2_place_ad_response_diagnostics.cjs");

const QUERY = "diagnostic fixture query";

function adKey(input) {
  return `adBusinesses(${JSON.stringify({ input })})`;
}

function baseState() {
  return {
    ROOT_QUERY: {
      [`accommodationSearch(${JSON.stringify({ input: { query: QUERY, display: 50 } })})`]: {
        business: { items: [], total: 0 }
      },
      "viewer": { id: "ignored" }
    },
    "Ad:1": { id: "101", name: "Fixture Ad One", adId: "ad-1" },
    "Ad:2": { id: "102", name: "Fixture Ad Two", adId: "" }
  };
}

function diagnose(state, body = "fixture-secret-value must be hashed only") {
  return buildAdResponseDiagnostics({ state, query: QUERY, body });
}

function assertNoRawLeak(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /fixture-secret-value/u);
  assert.doesNotMatch(serialized, /__APOLLO_STATE__/u);
  assert.doesNotMatch(serialized, /authorization|set-cookie/iu);
}

function main() {
  const populated = baseState();
  populated.ROOT_QUERY[adKey({ query: QUERY, businessType: "accommodation" })] = {
    items: [{ __ref: "Ad:1" }, { __ref: "Ad:2" }],
    total: 2
  };
  const populatedResult = diagnose(populated);
  assert.equal(populatedResult.schemaVersion, SCHEMA_VERSION);
  assert.equal(populatedResult.status, "current-filter-matched-with-items");
  assert.equal(populatedResult.response.rawProviderResponseStored, false);
  assert.equal(populatedResult.response.providerHeadersStored, false);
  assert.equal(populatedResult.response.cookieValuesStored, false);
  assert.match(populatedResult.response.bodySha256, /^[a-f0-9]{64}$/u);
  assert.equal(populatedResult.apollo.operationCounts.accommodationSearch, 1);
  assert.equal(populatedResult.apollo.operationCounts.adBusinesses, 1);
  assert.equal(populatedResult.apollo.operationCounts.other, 0);
  assert.equal(populatedResult.apollo.operationCounts.unparseable, 1);
  assert.equal(populatedResult.advertisement.candidateCount, 1);
  assert.equal(populatedResult.advertisement.matchedCandidateCount, 1);
  assert.equal(populatedResult.advertisement.matchedDirectItemCount, 2);
  assert.equal(populatedResult.advertisement.candidates[0].direct.placeIdPresentCount, 2);
  assert.equal(populatedResult.advertisement.candidates[0].direct.namePresentCount, 2);
  assert.equal(populatedResult.advertisement.candidates[0].direct.adIdPresentCount, 1);
  assertNoRawLeak(populatedResult);

  const empty = baseState();
  empty.ROOT_QUERY[adKey({ query: QUERY, businessType: "accommodation" })] = { items: [], total: 0 };
  const emptyResult = diagnose(empty);
  assert.equal(emptyResult.status, "current-filter-matched-empty");
  assert.equal(emptyResult.advertisement.candidateCount, 1);
  assert.equal(emptyResult.advertisement.matchedCandidateCount, 1);
  assert.equal(emptyResult.advertisement.matchedDirectItemCount, 0);
  assert.equal(emptyResult.advertisement.candidates[0].totalKnown, true);
  assert.equal(emptyResult.advertisement.candidates[0].total, 0);

  const filtered = baseState();
  filtered.ROOT_QUERY[adKey({ query: "different query", businessType: "accommodation" })] = {
    items: [{ __ref: "Ad:1" }],
    total: 1
  };
  const filteredResult = diagnose(filtered);
  assert.equal(filteredResult.status, "ad-candidates-filtered");
  assert.equal(filteredResult.advertisement.candidateCount, 1);
  assert.equal(filteredResult.advertisement.queryMatchedCandidateCount, 0);
  assert.equal(filteredResult.advertisement.accommodationCandidateCount, 1);
  assert.equal(filteredResult.advertisement.matchedCandidateCount, 0);

  const opening = baseState();
  opening.ROOT_QUERY[adKey({ query: QUERY, businessType: "accommodation", channel: "openingPlace" })] = {
    items: [{ __ref: "Ad:1" }],
    total: 1
  };
  const openingResult = diagnose(opening);
  assert.equal(openingResult.status, "ad-candidates-filtered");
  assert.equal(openingResult.advertisement.openingPlaceCandidateCount, 1);
  assert.equal(openingResult.advertisement.queryMatchedCandidateCount, 1);
  assert.equal(openingResult.advertisement.matchedCandidateCount, 0);

  const nested = baseState();
  nested.ROOT_QUERY[adKey({ query: QUERY, businessType: "accommodation" })] = {
    business: { items: [{ __ref: "Ad:1" }], total: 1 }
  };
  const nestedResult = diagnose(nested);
  assert.equal(nestedResult.status, "current-filter-matched-root-shape-mismatch");
  assert.equal(nestedResult.advertisement.candidates[0].direct.itemsArray, false);
  assert.equal(nestedResult.advertisement.candidates[0].business.itemsArray, true);
  assert.equal(nestedResult.advertisement.candidates[0].business.itemCount, 1);

  const absentResult = diagnose(baseState());
  assert.equal(absentResult.status, "ad-operation-absent");
  assert.equal(absentResult.advertisement.candidateCount, 0);
  assert.equal(absentResult.advertisement.matchedCandidateCount, 0);
  assertNoRawLeak(absentResult);

  assert.throws(() => buildAdResponseDiagnostics({ state: {}, query: QUERY, body: "x" }), TypeError);
  process.stdout.write(`${JSON.stringify({
    event: "v2_place_ad_response_diagnostics_tests_complete",
    assertions: 48,
    externalRequests: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: 0
  })}\n`);
}

main();
