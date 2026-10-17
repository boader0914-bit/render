"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { build, pack, expand, VERSION, ENCODING } = require("../web/regional-evidence-review.js");
const shared = require("../web/regional-data-contract.js");
const { createRegionalAnalysisSnapshotBuilder } = require("./lib/regional_analysis_snapshot.cjs");
const { createRegionalAnalysisStore } = require("./lib/regional_analysis_store.cjs");
const scope = { regionKey: "fixture_new_area", label: "새로운 지역", month: "2026-09", months: 13 };
const region = { regionKey: scope.regionKey, officialCode: "4800100000", level: "local", unitType: "county", active: true, selectable: true };
const clone = value => JSON.parse(JSON.stringify(value));
function spatial(period, type = "M", provider = "한국관광공사", original = true) {
  return shared.createSpatialContract({ region, provider, sourceRegion: { regionKey: scope.regionKey, regionCode: "48001", level: "sigungu" },
    evidence: { verified: true, regionKey: scope.regionKey, regionCode: "48001", level: "sigungu", observedRegionCodes: ["48001"],
      ...(original ? { storedProvenance: { version: "fixture-stored-response-v1", sourceKind: "stored_raw_response", evidenceId: "fixture_evidence_1",
        sha256: "a".repeat(64), period, periodType: type, verifiedAt: "2026-10-17T00:00:00Z", checks: ["fixture_proved"] } } : {}) } });
}
function metric(rows, extra = {}) { return { key: "amount", label: "관측 지표", unit: "명", periodType: "M", latestPeriod: rows.at(-1)?.period || "", rows, ...extra }; }
function bundle(metrics, extra = {}) { return { scope: { ...scope }, groups: [{ key: "visitors", label: "지역 방문자", category: "tourism", provider: "한국관광공사", periodType: "M", metrics, ...extra }] }; }
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test("observation and evidence axes keep normal zero, missing, suppression, partial, pending and rejection distinct", () => {
  const snapshot = bundle([metric([
    { period: "2026-01", value: 0, status: "observed", spatialContract: spatial("2026-01") },
    { period: "2026-02", value: 27, status: "observed", spatialContract: null },
    { period: "2026-03", value: null, status: "missing", reasonCode: "NOT_COLLECTED" },
    { period: "2026-04", value: 0, status: "error", reasonCode: "AUTH_ERROR" },
    { period: "2026-05", value: 0, status: "publication_pending" },
    { period: "2026-06", value: null, status: "suppressed", reasonCode: "SUPPRESSED" },
    { period: "2026-07", value: 0, status: "partial", reasonCode: "PARTIAL_DATA" },
    { period: "2026-08", value: 3, status: "observed", spatialContract: spatial("2026-07") }
  ])]);
  const before = JSON.stringify(snapshot), result = build(freeze(snapshot));
  assert.equal(result.version, VERSION); assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.scope, scope); assert.equal(JSON.stringify(snapshot), before);
  const byMonth = Object.fromEntries(result.items.map(item => [item.period, item]));
  assert.equal(byMonth["2026-01"].value, 0); assert.equal(byMonth["2026-01"].evidenceStatus, "verified");
  assert.equal(byMonth["2026-02"].value, 27); assert.equal(byMonth["2026-02"].evidenceStatus, "missing");
  assert.equal(byMonth["2026-03"].value, null); assert.equal(byMonth["2026-03"].observationStatus, "missing");
  assert.equal(byMonth["2026-04"].value, null); assert.equal(byMonth["2026-04"].observationStatus, "error");
  assert.equal(byMonth["2026-05"].priority, 5); assert.equal(byMonth["2026-05"].needsReview, false);
  assert.equal(byMonth["2026-06"].observationStatus, "suppressed"); assert.equal(byMonth["2026-06"].value, null);
  assert.equal(byMonth["2026-07"].observationStatus, "partial"); assert.equal(byMonth["2026-07"].value, null);
  assert.equal(byMonth["2026-08"].evidenceStatus, "rejected"); assert.equal(result.items[0].period, "2026-08");
  assert.equal(result.summary.normalZero, 1); assert.equal(result.summary.missingData, 1); assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.publicationPending, 1); assert.equal(result.summary.suppressed, 1); assert.equal(result.summary.partial, 1);
  assert.equal(result.summary.rejected, 1); assert.equal(result.summary.verified, 1);
});

test("a legacy matched response with no retained original stays observed and is not relabeled as a regional mismatch", () => {
  const contract = spatial("2026-09", "M", "한국관광공사", false);
  const result = build(bundle([metric([{ period: "2026-09", value: 0, status: "observed", spatialContract: contract,
    storedEvidenceVerification: { status: "already_verified", reasonCode: "RESPONSE_EVIDENCE_ALREADY_VERIFIED" } }])]));
  const item = result.items[0];
  assert.equal(item.value, 0); assert.equal(item.observationStatus, "observed");
  assert.equal(item.evidenceStatus, "missing"); assert.equal(item.priority, 4);
  assert.equal(item.reasonCode, "SOURCE_SCOPE_ONLY"); assert.equal(item.needsReview, true);
  assert.equal(contract.status, "matched"); assert.equal(result.summary.rejected, 0);
});

test("latest metric/group proof and diagnostics never transfer to older rows or explicit null row fields", () => {
  const latest = spatial("2026-09");
  const result = build(bundle([metric([
    { period: "2026-07", value: 1, status: "observed" },
    { period: "2026-08", value: 2, status: "observed", spatialContract: null, storedEvidenceVerification: null },
    { period: "2026-09", value: 3, status: "observed", spatialContract: latest, storedEvidenceVerification: null }
  ], { spatialContract: latest, storedEvidenceVerification: { status: "rejected", reasonCode: "EVIDENCE_HASH_MISMATCH" } })], { spatialContract: latest }));
  const byMonth = Object.fromEntries(result.items.map(item => [item.period, item]));
  assert.equal(byMonth["2026-07"].evidenceStatus, "missing");
  assert.equal(byMonth["2026-08"].evidenceStatus, "missing");
  assert.equal(byMonth["2026-09"].evidenceStatus, "verified");
  assert.equal(result.summary.rejected, 0);
});

test("an exact archive failure remains a separate issue without invalidating the prior observed zero or verified proof", () => {
  const snapshot = bundle([metric([
    { period: "2026-07", value: 0, status: "observed", spatialContract: spatial("2026-07") },
    { period: "2026-08", value: 0, status: "observed", spatialContract: spatial("2026-08"), refreshErrorCode: "EVIDENCE_WRITE_ERROR" },
    { period: "2026-09", value: 0, status: "observed", spatialContract: null,
      storedEvidenceVerification: { status: "pending", reasonCode: "RAW_RESPONSE_NOT_RETAINED" }, refreshErrorCode: "EVIDENCE_WRITE_ERROR" }
  ])], { lastRefreshErrorCode: "EVIDENCE_WRITE_ERROR", refresh: { errorCode: "EVIDENCE_WRITE_ERROR" } });
  const result = build(snapshot), byMonth = Object.fromEntries(result.items.map(item => [item.period, item]));
  assert.equal(byMonth["2026-07"].issues.length, 0, "A group error must not spread to every older month");
  assert.equal(byMonth["2026-08"].evidenceStatus, "verified"); assert.equal(byMonth["2026-08"].value, 0);
  assert.equal(byMonth["2026-08"].priority, 2); assert.equal(byMonth["2026-08"].issues[0].kind, "write_failed");
  assert.deepEqual(byMonth["2026-09"].reasonCodes, ["EVIDENCE_WRITE_ERROR", "RAW_RESPONSE_NOT_RETAINED"]);
  assert.equal(byMonth["2026-09"].issues.length, 2); assert.equal(byMonth["2026-09"].observationStatus, "observed");
  assert.equal(result.summary.writeFailed, 2); assert.equal(result.summary.verified, 2); assert.equal(result.summary.normalZero, 3);
});

test("a future publication point is included once, annual data remains one real year, and search is reference-only", () => {
  const snapshot = bundle([metric([{ period: "2026-08", value: 2, status: "observed", spatialContract: spatial("2026-08") }], {
    requestedPoint: { period: "2026-09", value: null, status: "publication_pending", reasonCode: "PUBLICATION_PENDING" }
  })]);
  snapshot.groups.push({ key: "kosis", label: "인구·산업", category: "background", provider: "KOSIS", metrics: [metric([
    { period: "2024", value: 0, status: "observed", spatialContract: spatial("2024", "Y", "KOSIS") }
  ], { key: "employment:employees", periodType: "Y", latestPeriod: "2024", requestedPoint: { period: "2026-09", status: "missing" } })] });
  snapshot.groups.push({ key: "searchTrend", label: "검색 트렌드", category: "search", provider: "네이버 데이터랩", periodType: "M", metrics: [metric([
    { period: "2026-09", value: 0, status: "observed" }
  ], { requestedPoint: { period: "2026-09", value: 0, status: "observed" } })] });
  const result = build(snapshot);
  assert.equal(result.items.length, 4);
  assert.equal(result.items.filter(item => item.periodType === "Y").length, 1);
  assert.equal(result.items.find(item => item.periodType === "Y").period, "2024");
  const search = result.items.find(item => item.sourceKey === "searchTrend");
  assert.equal(search.evidenceStatus, "reference"); assert.equal(search.priority, 6); assert.equal(search.needsReview, false);
  assert.equal(search.reasonCode, "KEYWORD_SCOPE"); assert.equal(result.summary.missingEvidence, 0);
  assert.equal(result.summary.referenceOnly, 1); assert.equal(result.summary.publicationPending, 1);
});

test("an unproven requested month does not inherit the latest original, but an explicit incomplete visitor original remains rejected", () => {
  const base = bundle([metric([{ period: "2026-08", value: 2, status: "observed", spatialContract: spatial("2026-08") }], {
    spatialContract: spatial("2026-08"), requestedPoint: { period: "2026-09", value: null, status: "missing", reasonCode: "NOT_COLLECTED" }
  })]);
  const fallback = build(base).items.find(item => item.period === "2026-09");
  assert.equal(fallback.evidenceStatus, "unavailable"); assert.equal(fallback.priority, 3);
  assert.equal(fallback.reasonCode, "NOT_COLLECTED");
  const requested = base.groups[0].metrics[0].requestedPoint;
  requested.spatialContract = { ...spatial("2026-09"), status: "scope_unverified", evidence: "unverified", reasonCode: "SCOPE_UNVERIFIED", storedProvenance: undefined };
  requested.storedEvidenceVerification = { status: "rejected", reasonCode: "VISITOR_RAW_INCOMPLETE_DAYS" };
  const explicit = build(base).items.find(item => item.period === "2026-09");
  assert.equal(explicit.evidenceStatus, "rejected"); assert.equal(explicit.priority, 1);
  assert.equal(explicit.reasonLabel, "방문자 일별 원본 미완결");
});

test("unknown errors, unsafe labels, paths and secret-looking codes never leak through the review projection", () => {
  const snapshot = bundle([metric([{ period: "2026-09", value: 0, status: "error", reasonCode: "API_SECRET_DO_NOT_COPY",
    error: { message: "https://private.invalid/?apiKey=DO_NOT_COPY" }, path: "C:\\DO_NOT_COPY\\original.json" }], {
    label: "https://private.invalid/?apiKey=DO_NOT_COPY", key: "https://private.invalid/DO_NOT_COPY"
  })], { label: "C:\\DO_NOT_COPY\\original.json", provider: "Authorization Bearer DO_NOT_COPY" });
  snapshot.scope.label = "file:///DO_NOT_COPY";
  const result = build(snapshot), text = JSON.stringify(result);
  assert.doesNotMatch(text, /DO_NOT_COPY|private\.invalid|Authorization|original\.json/);
  assert.equal(result.items[0].reasonCode, "UNRECORDED_REASON");
  assert.equal(result.items[0].reasonLabel, "사유 미기록");
  assert.equal(result.items[0].value, null);
});

test("all known original-verifier reasons have bounded Korean labels while arbitrary error codes remain unrecorded", () => {
  const codes = ["TOURISM_CACHE_IDENTITY_MISMATCH", "TOURISM_ORIGINAL_PAGINATION_INVALID", "TOURISM_ORIGINAL_QUERY_INCOMPLETE",
    "TOURISM_ORIGINAL_QUERY_MISMATCH", "TOURISM_ORIGINAL_RESPONSE_NOT_FOUND", "TOURISM_ORIGINAL_RESPONSE_UNREADABLE",
    "TOURISM_ORIGINAL_ROW_COUNT_INVALID", "TOURISM_ORIGINAL_SCHEMA_INVALID", "VISITOR_CACHE_IDENTITY_MISMATCH",
    "VISITOR_CACHE_REGION_AMBIGUOUS", "VISITOR_ORIGINAL_CHANGED_DURING_READ", "VISITOR_ORIGINAL_PATH_INVALID",
    "VISITOR_ORIGINAL_REFERENCE_INVALID", "VISITOR_ORIGINAL_RESPONSE_UNREADABLE", "VISITOR_ORIGINAL_ROW_COUNT_INVALID",
    "VISITOR_ORIGINAL_SIZE_INVALID", "VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID", "VISITOR_RAW_DUPLICATE_CONFLICT",
    "VISITOR_REGION_MAPPING_AMBIGUOUS", "VISITOR_REGION_MAPPING_UNVERIFIED", "STORED_EVIDENCE_UNVERIFIED"];
  for (const reasonCode of codes) {
    const review = build(bundle([metric([{ period: "2026-09", value: 0, status: "observed", spatialContract: null,
      storedEvidenceVerification: { status: "rejected", reasonCode } }])]));
    assert.equal(review.items[0].reasonCode, reasonCode);
    assert.match(review.items[0].reasonLabel, /[가-힣]/);
    assert.notEqual(review.items[0].reasonLabel, "사유 미기록");
  }
  const unknown = build(bundle([metric([{ period: "2026-09", value: 0, status: "error", reasonCode: "OS_EXCEPTION_DO_NOT_COPY" }])]));
  assert.equal(unknown.items[0].reasonCode, "UNRECORDED_REASON");
  assert.equal(unknown.items[0].reasonLabel, "사유 미기록");
});

test("duplicate periods are rejected and normal-looking string zeros never become observed numbers", () => {
  const result = build(bundle([metric([
    { period: "2026-08", value: 0, status: "observed", spatialContract: spatial("2026-08") },
    { period: "2026-08", value: 2, status: "observed", spatialContract: spatial("2026-08") },
    { period: "2026-09", value: "0", status: "observed", spatialContract: null }
  ])]));
  assert.equal(result.items.length, 2); assert.equal(result.items[0].reasonCode, "DUPLICATE_PERIOD");
  assert.equal(result.items[0].observationStatus, "error"); assert.equal(result.items[0].value, null);
  assert.equal(result.items.find(item => item.period === "2026-09").value, null);
  assert.equal(result.summary.normalZero, 0);
});

test("browser and Node build the same projection with networking, timers and storage forbidden", async () => {
  const source = await fs.readFile(path.join(__dirname, "../web/regional-evidence-review.js"), "utf8");
  const context = { RegionalDataContract: shared, fetch: () => assert.fail("Network forbidden"), setTimeout: () => assert.fail("Timer forbidden"),
    localStorage: new Proxy({}, { get: () => assert.fail("Storage forbidden") }) };
  vm.createContext(context); vm.runInContext(source, context);
  const snapshot = bundle([metric([{ period: "2026-09", value: 0, status: "observed", spatialContract: spatial("2026-09") }])]);
  assert.deepEqual(clone(context.RegionalEvidenceReview.build(clone(snapshot))), build(snapshot));
});

test("compact saved projection restores every computed state, issue, annual period and optional reference without changing inputs", () => {
  const snapshot = bundle([metric([
    { period: "2026-01", value: 0, status: "observed", spatialContract: spatial("2026-01") },
    { period: "2026-02", value: 2, status: "observed", spatialContract: null, referenceValue: 7 },
    { period: "2026-03", value: null, status: "missing", reasonCode: "NOT_COLLECTED" },
    { period: "2026-04", value: 0, status: "error", reasonCode: "AUTH_ERROR" },
    { period: "2026-05", value: 0, status: "publication_pending", reasonCode: "PUBLICATION_PENDING" },
    { period: "2026-06", value: null, status: "suppressed", reasonCode: "SUPPRESSED" },
    { period: "2026-07", value: 0, status: "partial", reasonCode: "PARTIAL_DATA" },
    { period: "2026-08", value: 0, status: "observed", spatialContract: null, refreshErrorCode: "EVIDENCE_WRITE_ERROR" },
    { period: "2026-09", value: 3, status: "observed", spatialContract: spatial("2026-08") }
  ]), metric([{ period: "2026-09", value: 0, status: "observed" }, { period: "2026-09", value: 2, status: "observed" }], { key: "duplicate" })]);
  snapshot.groups.push({ key: "kosis", label: "인구·산업", provider: "KOSIS", metrics: [metric([
    { period: "2024", value: 0, status: "observed", spatialContract: spatial("2024", "Y", "KOSIS") }
  ], { key: "employees", periodType: "Y", latestPeriod: "2024" })] });
  snapshot.groups.push({ key: "searchTrend", category: "search", provider: "네이버 데이터랩", periodType: "M", metrics: [metric([
    { period: "2026-09", value: 0, status: "observed" }
  ])] });
  const before = JSON.stringify(snapshot), model = freeze(build(snapshot)), packed = freeze(pack(model));
  assert.equal(packed.encoding, ENCODING); assert.equal(ENCODING, "compact-v1");
  assert.deepEqual(expand(packed, freeze(snapshot), { strict: true }), model);
  assert.deepEqual(expand(clone(model), snapshot, { strict: true }), model, "Previously verbose saved projections remain compatible");
  assert.equal(JSON.stringify(snapshot), before); assert.deepEqual(pack(model), packed);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(model)) / 3);
  assert.doesNotMatch(JSON.stringify(packed), /reasonLabel|metricLabel|provider|actionLabel|관광공사/);
});

test("compact projection supports an empty new region and unknown/empty actual periods without fabricating months", () => {
  for (const snapshot of [{ scope, groups: [] }, bundle([metric([], { periodType: "Y" })]), bundle([metric([], { periodType: "unexpected" })])]) {
    const model = build(snapshot);
    assert.deepEqual(expand(pack(model), snapshot, { strict: true }), model);
    assert.deepEqual(expand(undefined, snapshot), model);
  }
});

test("damaged compact or verbose saved projections fail safely and strict mode reports only a fixed safe error code", () => {
  const snapshot = bundle([metric([{ period: "2026-09", value: 0, status: "observed", spatialContract: spatial("2026-09") }])]);
  const model = build(snapshot), valid = pack(model);
  const mutations = [
    value => { value.encoding = "unsupported"; }, value => { value.scope.regionKey = "another_region"; },
    value => { value.metrics[0][1] = "another_metric"; }, value => { value.items[0][4] = 999; },
    value => { value.items[0][3] = "0"; }, value => { value.items[0][2] = "Y"; },
    value => { value.items[0][3] = 123; }, value => { value.items[0][1] = "2088-09"; },
    value => { value.items[0][7] = 1; }, value => { value.items[0][9] = 1; },
    value => { value.summary.normalZero = 0; }, value => { value.items[0].push("API_KEY_DO_NOT_COPY"); },
    value => { value.codes.push("PASSWORD_DO_NOT_COPY"); }, value => { value.items[0][10].push([1234, 0, 1, 0]); }
  ];
  for (const mutate of mutations) {
    const damaged = clone(valid); mutate(damaged); const before = JSON.stringify(damaged);
    assert.deepEqual(expand(freeze(damaged), snapshot), model);
    assert.throws(() => expand(damaged, snapshot, { strict: true }), error => error.code === "EVIDENCE_REVIEW_INVALID" && error.message === error.code);
    assert.equal(JSON.stringify(damaged), before);
  }
  const wrongLabel = clone(model); wrongLabel.items[0].provider = "SECRET_DO_NOT_COPY";
  assert.deepEqual(expand(wrongLabel, snapshot), model);
  assert.throws(() => expand(wrongLabel, snapshot, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
  const duplicateMetadata = clone(snapshot); duplicateMetadata.groups[0].metrics.push(clone(duplicateMetadata.groups[0].metrics[0]));
  assert.throws(() => expand(valid, duplicateMetadata, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
});

test("compact values, reference amounts, periods and observation states stay bound to existing rows and distinct requested points", () => {
  const snapshot = bundle([metric([{ period: "2026-08", value: 76.83, referenceValue: 2, status: "observed", spatialContract: spatial("2026-08") }], {
    requestedPoint: { period: "2026-09", value: 0, status: "publication_pending", reasonCode: "PUBLICATION_PENDING" }
  })]);
  const model = build(snapshot), packed = pack(model), target = packed.items.findIndex(item => item[1] === "2026-08");
  for (const mutate of [value => { value.items[target][3] = 199.83; }, value => { value.items[target][1] = "2088-09"; },
    value => { value.items[target][11] = 3; }, value => { value.items[target].pop(); }]) {
    const damaged = clone(packed); mutate(damaged);
    assert.throws(() => expand(damaged, snapshot, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
    assert.deepEqual(expand(damaged, snapshot), model);
  }
  const changedSource = clone(snapshot); changedSource.groups[0].metrics[0].rows[0].status = "missing";
  assert.throws(() => expand(packed, changedSource, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
  const removedPoint = clone(snapshot); delete removedPoint.groups[0].metrics[0].requestedPoint;
  assert.throws(() => expand(packed, removedPoint, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
  const changes = [
    value => { value.groups[0].metrics[0].rows[0].status = "missing"; value.groups[0].metrics[0].rows[0].value = null; },
    value => { value.groups[0].metrics[0].rows.pop(); },
    value => { value.groups[0].metrics[0].rows.push({ period: "2088-09", status: "observed", value: 5 }); },
    value => { value.groups[0].metrics[0].rows.push(clone(value.groups[0].metrics[0].rows[0])); }
  ];
  for (const change of changes) {
    const other = clone(snapshot); change(other);
    // Even a coherently rebuilt summary and tuple set must bind to the actual
    // saved observation set, rather than a different or fabricated history.
    const differentModel = pack(build(other));
    assert.throws(() => expand(differentModel, snapshot, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
    assert.deepEqual(expand(differentModel, snapshot), model);
  }
  assert.deepEqual(expand(packed, snapshot, { strict: true }), model);
});

test("saved classification inputs bind explicit rejections, null diagnostics and inherited evidence without original revalidation", () => {
  const snapshot = bundle([metric([{ period: "2026-08", value: 4, status: "observed", spatialContract: spatial("2026-08") }], {
    spatialContract: spatial("2026-08"), requestedPoint: { period: "2026-09", value: null, status: "partial", reasonCode: "PARTIAL_DATA",
      spatialContract: { status: "scope_unverified", evidence: "unverified", reasonCode: "SCOPE_UNVERIFIED" },
      storedEvidenceVerification: { status: "rejected", reasonCode: "VISITOR_RAW_INCOMPLETE_DAYS" } }
  })]);
  const expected = build(snapshot);
  assert.equal(expected.items.find(item => item.period === "2026-09").priority, 1);
  for (const change of [
    value => { value.groups[0].metrics[0].requestedPoint.storedEvidenceVerification = null; },
    value => { delete value.groups[0].metrics[0].requestedPoint.storedEvidenceVerification; },
    value => { value.groups[0].metrics[0].requestedPoint.spatialContract = null; },
    value => { value.groups[0].metrics[0].spatialContract = null; },
    value => { value.groups[0].metrics[0].rows[0].refreshErrorCode = "EVIDENCE_WRITE_ERROR"; }
  ]) {
    const other = clone(snapshot); change(other);
    const different = pack(build(other));
    assert.notEqual(different.inputFingerprint, expected.inputFingerprint);
    assert.throws(() => expand(different, snapshot, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
    assert.deepEqual(expand(different, snapshot), expected);
  }
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  assert.deepEqual(expand(pack(expected), reverseKeys(snapshot), { strict: true }), expected, "Object property order does not manufacture an input change");
  const legacy = clone(expected); delete legacy.inputFingerprint;
  assert.deepEqual(expand(legacy, snapshot), expected, "Older projections remain displayable through the safe snapshot-only fallback");
  assert.throws(() => expand(legacy, snapshot, { strict: true }), { code: "EVIDENCE_REVIEW_INVALID" });
});

test("valid compact expansion reads only snapshot metadata and never reclassifies or performs original/network/storage I/O", async () => {
  const snapshot = bundle([metric([{ period: "2026-09", value: 0, status: "observed", spatialContract: spatial("2026-09") }])]);
  const expected = build(snapshot), packed = pack(expected), forbidden = () => assert.fail("Reclassification or I/O forbidden");
  const context = { RegionalDataContract: new Proxy({}, { get: forbidden }), fetch: forbidden, require: forbidden, setTimeout: forbidden,
    localStorage: new Proxy({}, { get: forbidden }) };
  vm.createContext(context); vm.runInContext(await fs.readFile(path.join(__dirname, "../web/regional-evidence-review.js"), "utf8"), context);
  assert.deepEqual(clone(context.RegionalEvidenceReview.expand(clone(packed), clone(snapshot), { strict: true })), expected);
});

test("new snapshots persist the review version and preserve KOSIS suppressed/null values", async () => {
  const tourismCollector = Object.fromEntries(["collectVisitorHistory", "collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"]
    .map((method, index) => [method, async () => index === 0 ? { regions: [{ regionKey: scope.regionKey, series: [] }] } : { region: { regionKey: scope.regionKey }, series: [] }]));
  const buildSnapshot = createRegionalAnalysisSnapshotBuilder({ resolveRegion: async () => region, tourismCollector,
    now: () => new Date("2026-10-17T00:00:00Z"), searchTrendService: { get: async input => ({ ...input, series: [] }) },
    kosisService: { getRegion: async () => ({ region: { regionKey: scope.regionKey }, datasets: [{ key: "population", periodType: "M", period: "202609", status: "partial",
      mapping: { code: "48001" }, retrievedAt: "2026-10-01T00:00:00Z", spatialEvidence: { verified: true, regionKey: scope.regionKey, regionCode: "48001", level: "sigungu", observedRegionCodes: ["48001"] },
      rows: [{ key: "population", unit: "명", value: 0, status: "observed" }, { key: "male", unit: "명", value: null, status: "suppressed" }, { key: "female", unit: "명", value: null, status: "missing" }] }] }) } });
  const snapshot = await buildSnapshot(scope), group = snapshot.groups.find(group => group.key === "kosis");
  const suppressed = group.metrics.find(metric => metric.key === "population:male").rows[0];
  assert.equal(suppressed.status, "suppressed"); assert.equal(suppressed.reasonCode, "SUPPRESSED");
  assert.equal(suppressed.availability.status, "suppressed"); assert.equal(suppressed.value, null);
  assert.equal(group.metrics.find(metric => metric.key === "population:population").latestValue, 0);
  assert.equal(snapshot.evidenceReview.encoding, ENCODING);
  assert.deepEqual(expand(snapshot.evidenceReview, snapshot, { strict: true }), build(snapshot)); assert.equal(snapshot.evidenceReview.summary.suppressed, 1);
  assert.equal(snapshot.evidenceReview.version, VERSION);
  const oldInput = JSON.parse(JSON.stringify({ scope, calculationVersion: snapshot.calculationVersion, groups: snapshot.groups },
    (key, value) => ["retrievedAt", "refreshedStatus", "verifiedAt"].includes(key) ? undefined : value));
  assert.notEqual(snapshot.sourceFingerprint, crypto.createHash("sha256").update(JSON.stringify(oldInput)).digest("hex"));
  assert.equal((await buildSnapshot(scope)).sourceFingerprint, snapshot.sourceFingerprint);
});

test("retained last-good groups rebuild the saved review from final values rather than a failed incoming projection", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-review-retention-"));
  let failed = false;
  const store = createRegionalAnalysisStore({ dataDir: directory, autoStart: false, now: () => new Date("2026-10-17T00:00:00Z"),
    resolveRegion: async regionKey => ({ regionKey, label: scope.label }), buildSnapshot: async () => {
      const snapshot = bundle([metric([{ period: "2026-09", value: failed ? null : 0, status: failed ? "error" : "observed",
        reasonCode: failed ? "AUTH_ERROR" : "", spatialContract: spatial("2026-09") }])], { status: failed ? "failed" : "ready", errorCode: failed ? "AUTH_ERROR" : "" });
      snapshot.status = failed ? "partial" : "ready";
      // A second harmless source allows the failed first group to enter the
      // existing last-good retention policy rather than all-failed rejection.
      snapshot.groups.push({ key: "searchTrend", category: "search", status: "missing", metrics: [] });
      snapshot.sourceFingerprint = failed ? "failed-input" : "normal-input";
      snapshot.evidenceReview = build(snapshot);
      return snapshot;
    } });
  t.after(async () => { await store.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("regional-review-retention-")); await fs.rm(directory, { recursive: true, force: true }); });
  const input = { regionKey: scope.regionKey, month: scope.month, months: scope.months };
  await store.request(input); await store.waitForIdle(); const before = await store.get(input);
  failed = true; await store.request(input); await store.waitForIdle(); const after = await store.get(input);
  assert.equal(after.job.status, "completed"); assert.equal(after.snapshot.groups[0].stale, true);
  assert.equal(after.snapshot.groups[0].metrics[0].rows[0].value, 0);
  const expanded = expand(after.snapshot.evidenceReview, after.snapshot, { strict: true });
  assert.equal(after.snapshot.evidenceReview.encoding, ENCODING);
  assert.deepEqual(expanded, build(after.snapshot));
  assert.equal(expanded.items[0].observationStatus, "observed");
  assert.equal(expanded.items[0].evidenceStatus, "verified");
  assert.equal(after.snapshot.evidenceReview.summary.errors, 0, "A later group failure is not copied onto the retained old observation");
  assert.notEqual(after.snapshot.resultId, before.snapshot.resultId);
});
