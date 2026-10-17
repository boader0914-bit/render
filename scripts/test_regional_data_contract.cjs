"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { VERSION, createSpatialContract, comparisonEligibility, availabilityOf, temporalPolicy, storedProvenanceOf, storedEvidenceSummary } = require("../web/regional-data-contract.js");

const local = (officialCode = "4886000000") => ({ regionKey: `kr_admin_${officialCode}`, officialCode, level: "local", unitType: "county", active: true, selectable: true });
function verified(region = local(), extra = {}) {
  const regionCode = region.officialCode.slice(0, region.level === "broad" ? 2 : 5), level = region.level === "broad" ? "sido" : "sigungu";
  return { region, provider: "한국관광공사", sourceRegion: { regionKey: region.regionKey, signguCode: regionCode, unit: level },
    evidence: { verified: true, regionKey: region.regionKey, regionCode, level, mappingStatus: "ready" }, ...extra };
}
function cell(region = local(), extra = {}) {
  return { regionKey: region.regionKey, group: { key: "visitors", provider: "한국관광공사", periodType: "M", spatialContract: createSpatialContract(verified(region)) },
    metric: { key: "averageDailyVisitors", unit: "명" }, ...extra };
}
const pair = () => [cell(), cell(local("4824000000"))];
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("one contract policy is available in Node and a browser without I/O", () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/regional-data-contract.js"), "utf8"), sandbox);
  assert.equal(sandbox.RegionalDataContract.VERSION, "regional-data-contract-v1");
  assert.deepEqual(Object.keys(sandbox.RegionalDataContract).sort(), ["VERSION", "availabilityOf", "comparisonEligibility", "createSpatialContract", "temporalPolicy", "storedProvenanceOf", "storedEvidenceSummary"].sort());
  assert.equal(VERSION, "regional-data-contract-v1");
});

test("stored response provenance is bounded and cannot itself verify an echoed region", () => {
  const input = verified(), proof = { version: "stored-tourism-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "visitor-202608-abcdef0123456789",
    sha256: "a".repeat(64), period: "2026-08", verifiedAt: "2026-10-17T08:00:00Z", checks: ["hash", "region", "period", "values", "bad/secret", "hash"],
    relativePath: "arbitrary-path", url: "private", token: "secret" };
  const contract = createSpatialContract({ ...input, evidence: { ...input.evidence, storedProvenance: proof } });
  assert.equal(contract.status, "matched"); assert.deepEqual(contract.storedProvenance.checks, ["hash", "region", "period", "values"]);
  for (const field of ["relativePath", "url", "token"]) assert.equal(Object.hasOwn(contract.storedProvenance, field), false);
  assert.equal(storedEvidenceSummary(contract).label, "보관 원본 재검증");
  const echoed = createSpatialContract({ ...input, evidence: { storedProvenance: proof } });
  assert.equal(echoed.status, "scope_unverified"); assert.equal(echoed.storedProvenance, undefined);
  assert.equal(storedProvenanceOf({ ...proof, evidenceId: "<script>" }), null);
  assert.equal(storedProvenanceOf({ ...proof, sha256: "invalid" }), null);
  assert.equal(createSpatialContract({ ...input, evidence: { ...input.evidence, storedProvenance: { ...proof, sha256: "invalid" } } }).status, "scope_unverified");
  assert.equal(storedEvidenceSummary(echoed, { status: "pending", reasonCode: "RAW_RESPONSE_NOT_RETAINED" }).label, "보관 근거 미확인");
});

test("a canonical echo cannot verify geography, while response evidence preserves the exact administrative unit", () => {
  const input = verified();
  const echoed = createSpatialContract({ ...input, evidence: null });
  assert.equal(echoed.status, "scope_unverified"); assert.equal(echoed.evidence, "unverified");
  const result = createSpatialContract(freeze(input));
  assert.equal(result.status, "matched"); assert.equal(result.evidence, "response"); assert.equal(result.provider, "한국관광공사");
  assert.equal(result.requestedLevel, "sigungu"); assert.equal(result.providedLevel, "sigungu");
  assert.equal(result.officialCode, "4886000000"); assert.equal(result.providerRegionCode, "48860"); assert.equal(result.aggregation, "none");
  assert.equal(createSpatialContract({ ...input, sourceRegion: { regionKey: input.region.regionKey, ktoSggCd: "48860", unit: "기초지자체" } }).status, "matched");
});

test("annual stored proof requires its own frequency and never impersonates a monthly reference", () => {
  const monthly = { version: "regional-response-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "kosis-response-fixture",
    sha256: "b".repeat(64), period: "2026-08", verifiedAt: "2026-10-17T00:00:00Z", checks: ["hash", "metadata_region_ancestry", "values"] };
  assert.equal(storedProvenanceOf(monthly).period, "2026-08", "legacy monthly evidence remains compatible");
  const annual = storedProvenanceOf({ ...monthly, period: "2024", periodType: "Y" });
  assert.equal(annual.period, "2024"); assert.equal(annual.periodType, "Y");
  for (const patch of [{ period: "2024" }, { period: "2024", periodType: "M" }, { periodType: "Y" }, { periodType: "unknown" }, { period: "2026-13" }]) {
    assert.equal(storedProvenanceOf({ ...monthly, ...patch }), null);
  }
  const input = verified();
  const contract = createSpatialContract({ ...input, evidence: { ...input.evidence, storedProvenance: { ...monthly, period: "2024", periodType: "Y" } } });
  assert.equal(contract.status, "matched"); assert.equal(storedEvidenceSummary(contract).period, "2024");
  assert.equal(storedEvidenceSummary(null, { status: "pending", reasonCode: "EVIDENCE_WRITE_ERROR" }).reason, "응답 원본을 보관하지 못했습니다.");
});

test("missing verification fields never graduate into a matched response", () => {
  const input = verified();
  for (const field of ["verified", "regionKey", "regionCode", "level"]) {
    const candidate = clone(input); delete candidate.evidence[field];
    assert.notEqual(createSpatialContract(candidate).status, "matched", field);
  }
  assert.equal(createSpatialContract({ region: input.region, provider: "KOSIS" }).status, "scope_unverified");
  assert.equal(createSpatialContract({ region: input.region, provider: "KOSIS", evidence: { verified: true, regionKey: input.region.regionKey, level: "sigungu" } }).status,
    "scope_unverified", "missing both response and evidence codes cannot verify a provider scope");
  assert.equal(createSpatialContract({ ...input, evidence: { ...input.evidence, verified: "true" } }).status, "scope_unverified");
});

test("response key, code and level conflicts are held even with a verified flag", () => {
  const input = verified();
  for (const change of [
    { sourceRegion: { ...input.sourceRegion, regionKey: "kr_admin_4824000000" } },
    { sourceRegion: { ...input.sourceRegion, signguCode: "48240" } },
    { sourceRegion: { ...input.sourceRegion, unit: "sido" } },
    { sourceRegion: { ...input.sourceRegion, regionCode: "48240" } },
    { evidence: { ...input.evidence, regionKey: "elsewhere" } },
    { evidence: { ...input.evidence, regionCode: "48240" } },
    { evidence: { ...input.evidence, level: "sido" } }
  ]) assert.equal(createSpatialContract({ ...input, ...change }).status, "response_mismatch", JSON.stringify(change));
  const wrongSubdistrict = { ...input, sourceRegion: { ...input.sourceRegion, signguCode: "48861" }, evidence: { ...input.evidence, regionCode: "48861" } };
  assert.equal(createSpatialContract(wrongSubdistrict).status, "response_mismatch", "matching echo evidence cannot replace the requested official KTO unit");
  assert.equal(createSpatialContract({ ...wrongSubdistrict, region: { ...input.region, providerMappings: { kto: { ktoSggCd: "48861", status: "ready" } } } }).status,
    "response_mismatch", "a conflicting provider mapping cannot override the requested official administrative unit");
});

test("mapping presence and response verification remain separate and pending mappings stay pending", () => {
  const input = verified();
  for (const pending of ["pending", "mapping_pending", "verify-before-api-call", "administrative-reform-pending"]) {
    assert.equal(createSpatialContract({ ...input, sourceRegion: { ...input.sourceRegion, codeStatus: pending } }).status, "mapping_pending");
  }
  assert.equal(createSpatialContract({ ...input, region: { ...input.region, providerMappings: { kto: { ktoSggCd: "48860", status: "pending" } } } }).status, "mapping_pending");
  assert.equal(createSpatialContract({ ...input, region: { ...input.region, providerMappings: { kto: { status: "missing" } } } }).status, "mapping_missing");
  const mappedButUnread = createSpatialContract({ region: input.region, provider: input.provider });
  assert.equal(mappedButUnread.providerRegionCode, "48860"); assert.equal(mappedButUnread.status, "scope_unverified");
});

test("raw collector diagnostics prioritize actual mismatches and do not mistake empty responses for absent mappings", () => {
  const input = verified();
  const raw = { verified: false, regionKey: input.region.regionKey, regionCode: "", level: "sigungu", mappingStatus: "pending", observedRegionCodes: [], reasonCode: "NO_DATA" };
  for (const mappingStatus of ["pending", "mapped"]) {
    assert.equal(createSpatialContract({ ...input, evidence: { ...raw, mappingStatus } }).status, "scope_unverified");
    assert.equal(createSpatialContract({ ...input, evidence: { ...raw, mappingStatus, reasonCode: "MAPPING_MISSING" } }).status, "scope_unverified",
      "absence of a response code is not proof that the provider mapping is missing");
    const invalid = createSpatialContract({ ...input, evidence: { ...raw, mappingStatus, observedRegionCodes: ["48860"], reasonCode: "INVALID_RESPONSE" } });
    assert.equal(invalid.status, "scope_unverified"); assert.equal(invalid.reasonCode, "INVALID_RESPONSE");
    for (const evidence of [
      { ...raw, mappingStatus, reasonCode: "REGION_MISMATCH" },
      { ...raw, mappingStatus, observedRegionCodes: ["48240"] },
      { ...raw, mappingStatus, observedRegionCodes: ["48860", "48240"] },
      { ...raw, mappingStatus, observedRegionCodes: ["48240"], reasonCode: "INVALID_RESPONSE" }
    ]) {
      assert.equal(createSpatialContract({ ...input, evidence }).status, "response_mismatch");
      assert.equal(createSpatialContract({ ...input, region: { ...input.region, providerMappings: { kto: { status: "pending" } } }, evidence }).status,
        "response_mismatch", "an actual mapping hold cannot conceal observed response geography that conflicts with the request");
    }
  }
  assert.equal(createSpatialContract({ ...input, region: { ...input.region, codeStatus: "verify-before-api-call" }, evidence: raw }).status, "mapping_pending");
  const noCodeRegion = { regionKey: "legacy_region", level: "local" };
  assert.equal(createSpatialContract({ region: noCodeRegion, provider: "한국관광공사", sourceRegion: { regionKey: "legacy_region" } }).status, "scope_unverified");
});

test("collector evidence flows through a saved snapshot without replacing no-data or mismatch reasons with mapping errors", async () => {
  const { createRegionalAnalysisSnapshotBuilder } = require("./lib/regional_analysis_snapshot.cjs");
  const region = local();
  const raw = { verified: false, regionKey: region.regionKey, regionCode: "", level: "sigungu", mappingStatus: "pending", observedRegionCodes: [], reasonCode: "NO_DATA" };
  let evidence = raw;
  const build = createRegionalAnalysisSnapshotBuilder({ resolveRegion: async () => region,
    tourismCollector: { collectVisitorHistory: async () => ({ networkAttempted: false, regions: [{ regionKey: region.regionKey, ktoSggCd: "48860", series: [
      { yearMonth: "202609", status: evidence.reasonCode === "INVALID_RESPONSE" ? "failed" : "missing", averageDailyVisitors: null, visitorDays: null,
        reason: evidence.reasonCode === "INVALID_RESPONSE" ? "schema_error" : "no_observation", spatialEvidence: evidence }
    ] }] }) },
    kosisService: { getRegion: async () => ({ region: { regionKey: region.regionKey }, datasets: [] }) },
    searchTrendService: { get: async input => ({ ...input, series: [] }) }, now: () => "2026-10-17T00:00:00Z" });
  const scope = { regionKey: region.regionKey, month: "2026-09", months: 13 };
  let point = (await build(scope)).groups[0].metrics[0].requestedPoint;
  assert.equal(point.spatialContract.status, "scope_unverified"); assert.equal(point.reasonCode, "NO_DATA"); assert.equal(point.status, "missing");
  evidence = { ...raw, observedRegionCodes: ["48240"], reasonCode: "REGION_MISMATCH" };
  point = (await build(scope)).groups[0].metrics[0].requestedPoint;
  assert.equal(point.spatialContract.status, "response_mismatch"); assert.equal(point.reasonCode, "REGION_MISMATCH"); assert.equal(point.status, "error");
  evidence = { ...raw, observedRegionCodes: ["48860"], reasonCode: "INVALID_RESPONSE" };
  point = (await build(scope)).groups[0].metrics[0].requestedPoint;
  assert.equal(point.spatialContract.status, "scope_unverified"); assert.equal(point.reasonCode, "INVALID_RESPONSE"); assert.equal(point.status, "error");
});

test("provider code systems stay distinct and administrative levels never aggregate", () => {
  const region = local();
  const kosis = createSpatialContract({ region, provider: "KOSIS", sourceRegion: { regionKey: region.regionKey, areaCode: "38390", level: "local" },
    evidence: { verified: true, regionKey: region.regionKey, regionCode: "38390", level: "sigungu", mappingStatus: "ready" } });
  assert.equal(kosis.status, "matched"); assert.equal(kosis.providerRegionCode, "38390"); assert.equal(kosis.officialCode, region.officialCode);
  const broad = { regionKey: "kr_admin_4800000000", officialCode: "4800000000", level: "broad", unitType: "province" };
  const province = createSpatialContract({ region: broad, provider: "한국관광공사", sourceRegion: { regionKey: broad.regionKey, ktoSidoCd: "48", unit: "sido" },
    evidence: { verified: true, regionKey: broad.regionKey, regionCode: "48", level: "sido" } });
  assert.equal(province.status, "matched"); assert.equal(province.providedLevel, "sido"); assert.equal(province.aggregation, "none");
  for (const change of [{ active: false }, { selectable: false }, { unitType: "general_district" }]) {
    const result = createSpatialContract(verified({ ...region, ...change }));
    assert.equal(result.status, "scope_unverified"); assert.equal(result.reasonCode, "REGION_NOT_SELECTABLE");
  }
});

test("keyword validation is explicit and it never authorizes cross-region index comparison", () => {
  const region = local(), input = { region, provider: "네이버 데이터랩", scopeKind: "keyword", sourceRegion: { regionKey: region.regionKey },
    evidence: { verified: true, regionKey: region.regionKey, keywordVerified: true } };
  const contract = createSpatialContract(input);
  assert.equal(contract.status, "matched"); assert.equal(contract.evidence, "keyword"); assert.equal(contract.scopeKind, "keyword");
  assert.equal(createSpatialContract({ ...input, evidence: { ...input.evidence, keywordVerified: false } }).status, "scope_unverified");
  assert.equal(createSpatialContract({ ...input, sourceRegion: { regionKey: "different" } }).status, "response_mismatch");
  const candidate = cell(); candidate.group.spatialContract = contract; candidate.group.provider = input.provider;
  assert.equal(comparisonEligibility([candidate]).reasonCode, "KEYWORD_SCOPE");
  candidate.metric.spatialContract = cell().group.spatialContract;
  assert.equal(comparisonEligibility([candidate]).reasonCode, "KEYWORD_SCOPE", "a metric override cannot relabel a keyword group as administrative data");
});

test("direct comparison accepts different verified region codes under the same provider, unit and frequency", () => {
  const cells = pair(), before = clone(cells), result = comparisonEligibility(freeze(cells));
  assert.equal(result.comparable, true); assert.equal(result.periodType, "M"); assert.equal(result.providedLevel, "sigungu");
  assert.match(result.reason, /일치/); assert.deepEqual(cells, before);
  assert.notEqual(cells[0].group.spatialContract.providerRegionCode, cells[1].group.spatialContract.providerRegionCode);
});

test("missing legacy contracts, copied scope, duplicate scopes and unknown schema are not comparable", () => {
  for (const mutate of [
    cells => { delete cells[1].group.spatialContract; },
    cells => { cells[1].group.spatialContract.version = "regional-data-contract-v0"; },
    cells => { cells[1].group.spatialContract.evidence = "unverified"; },
    cells => { cells[1].group.spatialContract.aggregation = "sum"; },
    cells => { cells[1].group.spatialContract = clone(cells[0].group.spatialContract); },
    cells => { cells[1].group.spatialContract.providerRegionCode = cells[0].group.spatialContract.providerRegionCode; },
    cells => { cells[1].regionKey = cells[0].regionKey; }
  ]) { const cells = pair(); mutate(cells); assert.equal(comparisonEligibility(cells).comparable, false); }
  assert.equal(comparisonEligibility([]).reasonCode, "SCOPE_UNVERIFIED");
  const pending = pair(); pending[1].group.spatialContract.status = "mapping_pending";
  assert.equal(comparisonEligibility(pending).reasonCode, "MAPPING_PENDING");
});

test("provider, units, monthly/annual frequencies, levels and metric identities cannot mix", () => {
  const cases = [
    ["PROVIDER_MISMATCH", cells => { cells[1].group.provider = "KOSIS"; cells[1].group.spatialContract.provider = "KOSIS"; }],
    ["UNIT_MISMATCH", cells => { cells[1].metric.unit = "지수"; }],
    ["UNIT_UNVERIFIED", cells => { cells[1].metric.unit = ""; }],
    ["PERIOD_TYPE_MISMATCH", cells => { cells[1].metric.periodType = "Y"; }],
    ["PERIOD_TYPE_UNVERIFIED", cells => { delete cells[1].group.periodType; }],
    ["LEVEL_MISMATCH", cells => { cells[1].group.spatialContract.requestedLevel = "sido"; cells[1].group.spatialContract.providedLevel = "sido"; }],
    ["METRIC_MISMATCH", cells => { cells[1].metric.key = "visitorDays"; }]
  ];
  for (const [reason, mutate] of cases) { const cells = pair(); mutate(cells); assert.equal(comparisonEligibility(cells).reasonCode, reason); }
  const annual = pair(); annual.forEach(item => { item.group.periodType = "mixed"; item.metric.periodType = "Y"; });
  assert.equal(comparisonEligibility(annual).comparable, true); assert.equal(comparisonEligibility(annual).periodType, "Y");
});

test("per-dataset KOSIS contracts may supply an exact mapping, but conflicting outer scope is rejected", () => {
  const cells = pair();
  for (const item of cells) {
    item.group.provider = "KOSIS"; item.group.spatialContract.provider = "KOSIS";
    item.metric.spatialContract = clone(item.group.spatialContract); item.group.spatialContract.status = "scope_unverified";
  }
  assert.equal(comparisonEligibility(cells).comparable, true);
  cells[1].group.spatialContract.requestedRegionKey = "different";
  assert.equal(comparisonEligibility(cells).reasonCode, "RESPONSE_REGION_MISMATCH");
});

test("availability preserves a genuine zero and separates missing, failed, pending, partial and explicit unsupported", () => {
  for (const status of ["observed", "ready", "complete", "available"]) assert.deepEqual(availabilityOf({ status, value: 0 }), { status: "observed", value: 0, observed: true, reasonCode: "" });
  for (const value of [null, undefined, "0", NaN, Infinity, -1]) assert.equal(availabilityOf({ status: "observed", value }).observed, false);
  const missing = availabilityOf({ status: "missing", value: 0 }); assert.equal(missing.status, "missing"); assert.equal(missing.value, null);
  assert.equal(availabilityOf({ status: "failed", value: 0 }).status, "error");
  assert.equal(availabilityOf({ status: "publication_pending", value: 0 }).status, "publication_pending");
  assert.equal(availabilityOf({ reason: "not_published" }).status, "publication_pending");
  assert.equal(availabilityOf({ status: "partial", value: 7 }).status, "partial");
  assert.equal(availabilityOf({ status: "unsupported" }).status, "unsupported");
  assert.equal(availabilityOf({}).status, "missing"); assert.equal(availabilityOf(null).status, "missing");
  assert.equal(availabilityOf({ status: "observed", value: 0, refreshErrorCode: "TIMEOUT" }).observed, true);
});

test("monthly coverage anchors on source observations; annual values retain actual periods without monthly slicing", () => {
  const monthly = temporalPolicy({ month: "2026-09" });
  assert.equal(monthly.anchor, "latest_observed"); assert.equal(monthly.expectedMonths, 13); assert.equal(monthly.requestedThrough, "2026-09");
  assert.equal(temporalPolicy({ month: "2026-09", months: 24 }).expectedMonths, 24);
  assert.equal(temporalPolicy({ month: "2026-09", months: 36 }).expectedMonths, 24);
  for (const periodType of ["Y", "annual"]) {
    const annual = temporalPolicy({ month: "2026-09", months: 24, periodType });
    assert.equal(annual.expectedMonths, null); assert.equal(annual.anchor, "actual_publication"); assert.equal(annual.annualSlicing, false);
  }
  assert.equal(temporalPolicy({ month: "2026-13" }).requestedThrough, "");
  assert.equal(temporalPolicy({ periodType: "mixed" }).expectedMonths, null);
});
